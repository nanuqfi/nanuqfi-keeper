import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { Keeper } from '../keeper.js'
import { HealthMonitor } from '../health/monitor.js'
import type { KeeperConfig } from '../config.js'
import type { KeeperDecision } from '../keeper.js'

const mockSubmitRebalance = vi.mocked(submitRebalance)

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
})
