import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Keeper } from './keeper'
import { HealthMonitor } from './health/monitor'
import type { KeeperConfig } from './config'

const mockConfig: KeeperConfig = {
  rpcUrls: ['http://localhost:8899'],
  keeperKeypairPath: '/tmp/test-keypair.json',
  cycleIntervalMs: 100,
  aiCycleIntervalMs: 1000,
  aiApiKey: 'test-key',
  aiModel: 'claude-sonnet-4-6',
  aiMaxCallsPerHour: 10,
  aiBudgetPerDay: 5,
}

// Mock fetch for scanner HTTP calls — prevents real network access during tests
const originalFetch = globalThis.fetch

function mockFetchForCycle() {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    // DeFi Llama — return minimal valid response
    if (typeof url === 'string' && url.includes('llama.fi')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'success', data: [] }),
      })
    }
    // Drift rate history
    if (typeof url === 'string' && url.includes('rateHistory')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ rates: [] }),
      })
    }
    // Drift funding rates
    if (typeof url === 'string' && url.includes('fundingRates')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ fundingRates: [] }),
      })
    }
    // Default — empty OK
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

describe('Keeper', () => {
  let keeper: Keeper
  let monitor: HealthMonitor

  beforeEach(() => {
    monitor = new HealthMonitor()
    keeper = new Keeper({ config: mockConfig, monitor })
  })

  afterEach(() => {
    keeper.stop()
    globalThis.fetch = originalFetch
  })

  it('runs a cycle and records success', async () => {
    mockFetchForCycle()
    await keeper.runCycle()
    const status = monitor.getStatus()
    expect(status.cyclesCompleted).toBe(1)
    expect(status.lastCycleTimestamp).toBeGreaterThan(0)
  })

  it('records multiple cycles', async () => {
    mockFetchForCycle()
    await keeper.runCycle()
    await keeper.runCycle()
    await keeper.runCycle()
    expect(monitor.getStatus().cyclesCompleted).toBe(3)
  })

  it('stops cleanly', () => {
    keeper.stop()
    // No error, no pending timers
  })

  it('boot fails when all RPCs are down', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))

    await expect(keeper.boot()).rejects.toThrow('All RPC endpoints unreachable')
    expect(monitor.getStatus().rpcStatus).toBe('down')
  })

  it('boot succeeds when RPC is healthy', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })

    await keeper.boot()
    expect(monitor.getStatus().rpcStatus).toBe('healthy')
  })

  // -------------------------------------------------------------------------
  // New tests for wired keeper cycle
  // -------------------------------------------------------------------------

  it('produces weight proposals for moderate and aggressive vaults', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const weights = keeper.getCurrentWeights()
    expect(weights['moderate']).toBeDefined()
    expect(weights['aggressive']).toBeDefined()

    // moderate has 3 backends (lending, basis, jito-dn)
    const moderateKeys = Object.keys(weights['moderate']!)
    expect(moderateKeys.length).toBeGreaterThanOrEqual(1)

    // aggressive has 4 backends (lending, basis, jito-dn, funding)
    const aggressiveKeys = Object.keys(weights['aggressive']!)
    expect(aggressiveKeys.length).toBeGreaterThanOrEqual(1)
  })

  it('uses default yield data when no DriftDataCache is present', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const yieldData = keeper.getYieldData()
    expect(yieldData).not.toBeNull()
    // Default values when no dataCache
    expect(yieldData!.usdcLendingRate).toBe(0.02)
    expect(yieldData!.solBorrowRate).toBe(0.05)
    expect(yieldData!.jitoStakingYield).toBe(0.07)
  })

  it('records decisions with timestamps', async () => {
    mockFetchForCycle()
    const before = Date.now()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    // 2 decisions per cycle: moderate + aggressive
    expect(decisions).toHaveLength(2)
    expect(decisions[0]!.riskLevel).toBe('moderate')
    expect(decisions[1]!.riskLevel).toBe('aggressive')
    expect(decisions[0]!.timestamp).toBeGreaterThanOrEqual(before)
    expect(decisions[0]!.proposal.weights).toBeDefined()
    expect(decisions[0]!.proposal.scores).toBeDefined()
  })

  it('accumulates decisions across cycles', async () => {
    mockFetchForCycle()
    await keeper.runCycle()
    await keeper.runCycle()

    // 2 per cycle × 2 cycles = 4 decisions
    expect(keeper.getDecisions()).toHaveLength(4)
  })

  it('populates market scan after cycle', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const scan = keeper.getMarketScan()
    expect(scan).not.toBeNull()
    expect(scan!.timestamp).toBeGreaterThan(0)
    expect(scan!.driftComparison).toBeDefined()
  })

  it('aggressive vault includes drift-funding backend', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    const aggressiveDecision = decisions.find(d => d.riskLevel === 'aggressive')
    expect(aggressiveDecision).toBeDefined()
    // drift-funding score should be present
    expect(aggressiveDecision!.proposal.scores['drift-funding']).toBeDefined()
  })

  it('moderate vault does NOT include drift-funding backend', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    const moderateDecision = decisions.find(d => d.riskLevel === 'moderate')
    expect(moderateDecision).toBeDefined()
    // drift-funding should not appear
    expect(moderateDecision!.proposal.scores['drift-funding']).toBeUndefined()
  })

  it('weights sum to 10000 bps per vault', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const weights = keeper.getCurrentWeights()
    for (const riskLevel of ['moderate', 'aggressive']) {
      const vaultWeights = weights[riskLevel]!
      const sum = Object.values(vaultWeights).reduce((a, b) => a + b, 0)
      expect(sum).toBe(10_000)
    }
  })
})
