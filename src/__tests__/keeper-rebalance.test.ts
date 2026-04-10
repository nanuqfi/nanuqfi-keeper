import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PublicKey } from '@solana/web3.js'

// Mock external dependencies before importing anything that uses them.
// Vitest hoists vi.mock calls so order doesn't matter, but they must be
// at module scope.
vi.mock('../chain/rebalance.js', () => ({
  submitRebalance: vi.fn(),
  weightsToU16Array: vi.fn(),
  hashReasoning: vi.fn(),
  riskLevelToIndex: vi.fn(),
  deriveAllocatorPda: vi.fn(),
  deriveRiskVaultPda: vi.fn(),
  deriveRebalanceRecordPda: vi.fn(),
  deriveTreasuryPda: vi.fn(),
  PROGRAM_ID: 'mock-program-id',
}))

vi.mock('../chain/state.js', () => ({
  fetchRebalanceChainState: vi.fn(),
}))

vi.mock('../scanner/yield-scanner.js', () => ({
  scanDeFiYields: vi.fn().mockResolvedValue({
    timestamp: Date.now(),
    protocols: [],
    driftComparison: { kaminoVsDrift: 0, marginfiVsDrift: 0, luloVsDrift: 0 },
  }),
}))

vi.mock('../ai/prompt-builder.js', () => ({
  buildInsightPrompt: vi.fn().mockReturnValue('test prompt'),
}))

import { submitRebalance } from '../chain/rebalance.js'
import { fetchRebalanceChainState } from '../chain/state.js'
import { Keeper } from '../keeper.js'
import { HealthMonitor } from '../health/monitor.js'
import type { KeeperConfig } from '../config.js'
import type { KeeperDecision } from '../keeper.js'

const mockSubmitRebalance = vi.mocked(submitRebalance)
const mockFetchChainState = vi.mocked(fetchRebalanceChainState)

// Stable mock chain state values — tests that care about specific values override these.
const MOCK_VAULT_USDC = new PublicKey('So11111111111111111111111111111111111111112')
const MOCK_TREASURY_USDC = new PublicKey('SysvarRent111111111111111111111111111111111')
const MOCK_CHAIN_STATE = {
  rebalanceCounter: 7,
  vaultUsdcAddress: MOCK_VAULT_USDC,
  treasuryUsdcAddress: MOCK_TREASURY_USDC,
  equitySnapshot: 250_000_000n, // 250 USDC (6 decimals)
}

const mockConfig: KeeperConfig = {
  rpcUrls: ['https://test-rpc.com'],
  keeperKeypairPath: '/tmp/test-keypair.json',
  cycleIntervalMs: 60_000,
  aiCycleIntervalMs: 999_999,
  aiApiKey: '',
  aiModel: 'claude-sonnet-4-6',
  aiMaxCallsPerHour: 10,
  aiBudgetPerDay: 5,
  alertTelegramToken: undefined,
  alertTelegramChatId: undefined,
}

// Stub fetch so keeper.fetchYieldData() doesn't hit real network
// and RPC health check doesn't fail.
const originalFetch = globalThis.fetch

function mockFetch() {
  globalThis.fetch = vi.fn().mockImplementation((url: unknown) => {
    const urlStr = typeof url === 'string' ? url : ''
    if (urlStr.includes('llama.fi') || urlStr.includes('test-rpc.com')) {
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }
    // Kamino API — return empty reserve list (triggers fallback yield)
    return Promise.resolve({ ok: false })
  })
}

describe('keeper rebalance awaiting', () => {
  let keeper: Keeper
  let monitor: HealthMonitor
  let alertSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    mockFetch()

    monitor = new HealthMonitor()
    keeper = new Keeper({ config: mockConfig, monitor })

    // Stub fetchYieldData to avoid real HTTP calls
    ;(keeper as any).fetchYieldData = vi.fn().mockResolvedValue({
      kaminoSupplyRate: 0.08,
      marginfiLendingRate: 0.065,
      luloRegularRate: 0.07,
    })

    // Default: chain state fetch succeeds with stable mock values
    mockFetchChainState.mockResolvedValue(MOCK_CHAIN_STATE)

    // Inject a spy alerter so we can assert on alert calls
    alertSpy = vi.fn().mockResolvedValue(undefined)
    ;(keeper as any).alerter = { alert: alertSpy }
  })

  afterEach(() => {
    keeper.stop()
    globalThis.fetch = originalFetch
  })

  it('does NOT record decision as confirmed when submitRebalance fails', async () => {
    mockSubmitRebalance.mockResolvedValue({
      success: false,
      error: 'Transaction simulation failed',
    })

    await keeper.runCycle()

    const decisions: KeeperDecision[] = keeper.getDecisions()
    const failedDecisions = decisions.filter(d => d.txStatus === 'failed')
    expect(failedDecisions.length).toBeGreaterThan(0)

    const confirmedDecisions = decisions.filter(d => d.txStatus === 'confirmed')
    expect(confirmedDecisions).toHaveLength(0)
  })

  it('records decision as confirmed when submitRebalance succeeds', async () => {
    mockSubmitRebalance.mockResolvedValue({
      success: true,
      txSignature: 'abc123signature',
    })

    await keeper.runCycle()

    const decisions: KeeperDecision[] = keeper.getDecisions()
    const confirmed = decisions.filter(d => d.txStatus === 'confirmed')
    expect(confirmed.length).toBeGreaterThan(0)
    expect(confirmed[0]!.txSignature).toBe('abc123signature')
  })

  it('sends alert when rebalance tx fails', async () => {
    mockSubmitRebalance.mockResolvedValue({
      success: false,
      error: 'Blockhash expired',
    })

    await keeper.runCycle()

    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('rebalance failed'),
    )
  })

  it('does NOT update currentWeights when tx fails', async () => {
    // Pre-seed known weights so we can verify they don't change
    const originalWeights = {
      moderate: { 'kamino-lending': 5000, 'marginfi-lending': 3000, 'lulo-lending': 2000 },
      aggressive: { 'kamino-lending': 3000, 'marginfi-lending': 4000, 'lulo-lending': 3000 },
    }
    ;(keeper as any).currentWeights = { ...originalWeights }

    mockSubmitRebalance.mockResolvedValue({
      success: false,
      error: 'Simulation failed',
    })

    await keeper.runCycle()

    const weights = keeper.getCurrentWeights()
    // Failed tx must not update weights — they stay at original
    expect(weights['moderate']).toEqual(originalWeights.moderate)
    expect(weights['aggressive']).toEqual(originalWeights.aggressive)
  })

  it('decision never has undefined txStatus after runCycle in on-chain mode', async () => {
    // On-chain mode always resolves to confirmed or failed — never left undefined
    mockSubmitRebalance.mockResolvedValue({
      success: true,
      txSignature: 'sig-xyz',
    })

    await keeper.runCycle()

    const decisions: KeeperDecision[] = keeper.getDecisions()
    for (const d of decisions) {
      expect(d.txStatus).toBeDefined()
      expect(['confirmed', 'failed', 'pending']).toContain(d.txStatus)
    }
  })

  it('restoreCurrentWeights skips failed decisions', () => {
    const goodWeights = { 'kamino-lending': 5000, 'marginfi-lending': 3000, 'lulo-lending': 2000 }
    const badWeights = { 'kamino-lending': 9000, 'marginfi-lending': 500, 'lulo-lending': 500 }

    // Seed: confirmed decision first, then failed decision on top
    ;(keeper as any).decisions = [
      {
        timestamp: Date.now() - 2000,
        riskLevel: 'moderate',
        proposal: { weights: goodWeights, scores: {} },
        yieldData: { kaminoSupplyRate: 0.08, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
        txStatus: 'confirmed',
      },
      {
        timestamp: Date.now() - 1000,
        riskLevel: 'moderate',
        proposal: { weights: badWeights, scores: {} },
        yieldData: { kaminoSupplyRate: 0.08, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
        txStatus: 'failed',
      },
    ]

    ;(keeper as any).restoreCurrentWeights()

    // Must restore goodWeights (confirmed), not badWeights (failed)
    expect((keeper as any).currentWeights['moderate']).toEqual(goodWeights)
  })

  it('restoreCurrentWeights skips pending decisions', () => {
    const goodWeights = { 'kamino-lending': 4000, 'marginfi-lending': 3000, 'lulo-lending': 3000 }
    const pendingWeights = { 'kamino-lending': 8000, 'marginfi-lending': 1000, 'lulo-lending': 1000 }

    ;(keeper as any).decisions = [
      {
        timestamp: Date.now() - 2000,
        riskLevel: 'aggressive',
        proposal: { weights: goodWeights, scores: {} },
        yieldData: { kaminoSupplyRate: 0.08, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
        txStatus: 'confirmed',
      },
      {
        timestamp: Date.now() - 1000,
        riskLevel: 'aggressive',
        proposal: { weights: pendingWeights, scores: {} },
        yieldData: { kaminoSupplyRate: 0.08, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
        txStatus: 'pending',
      },
    ]

    ;(keeper as any).restoreCurrentWeights()

    // Must restore goodWeights (confirmed), not pendingWeights (unknown outcome)
    expect((keeper as any).currentWeights['aggressive']).toEqual(goodWeights)
  })

  it('restoreCurrentWeights accepts legacy decisions without txStatus (backward compat)', () => {
    const legacyWeights = { 'kamino-lending': 6000, 'marginfi-lending': 2000, 'lulo-lending': 2000 }

    ;(keeper as any).decisions = [
      {
        timestamp: Date.now() - 1000,
        riskLevel: 'moderate',
        proposal: { weights: legacyWeights, scores: {} },
        yieldData: { kaminoSupplyRate: 0.08, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
        // No txStatus — pre-fix legacy decision
      },
    ]

    ;(keeper as any).restoreCurrentWeights()

    // Legacy decisions (no txStatus) are treated as confirmed for backward compat
    expect((keeper as any).currentWeights['moderate']).toEqual(legacyWeights)
  })

  it('submitRebalance receives real chain state params (counter, equity, addresses)', async () => {
    mockSubmitRebalance.mockResolvedValue({ success: true, txSignature: 'chain-state-sig' })

    await keeper.runCycle()

    expect(mockSubmitRebalance).toHaveBeenCalled()

    // Both vaults (moderate + aggressive) are processed per cycle
    const calls = mockSubmitRebalance.mock.calls
    for (const [params] of calls) {
      // rebalanceCounter must come from chain state (7), not decisions.length
      expect(params.rebalanceCounter).toBe(MOCK_CHAIN_STATE.rebalanceCounter)
      // equitySnapshot must be the real balance, not 0n
      expect(params.equitySnapshot).toBe(MOCK_CHAIN_STATE.equitySnapshot)
      // Addresses must be the real PDAs, not System Program
      expect(params.vaultUsdcAddress.toBase58()).toBe(MOCK_VAULT_USDC.toBase58())
      expect(params.treasuryUsdcAddress.toBase58()).toBe(MOCK_TREASURY_USDC.toBase58())
    }
  })

  it('chain state fetch failure marks decision failed and sends alert', async () => {
    mockFetchChainState.mockRejectedValue(new Error('RiskVault account not found for moderate'))

    await keeper.runCycle()

    const decisions: KeeperDecision[] = keeper.getDecisions()
    const failed = decisions.filter(d => d.txStatus === 'failed')
    expect(failed.length).toBeGreaterThan(0)

    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('RiskVault account not found'),
    )
  })
})
