import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Keeper } from './keeper'
import { HealthMonitor } from './health/monitor'
import type { KeeperConfig } from './config'
import type { AIProvider } from './ai/index'

const mockConfig: KeeperConfig = {
  rpcUrls: ['http://localhost:8899'],
  // Empty keypair path = algorithm-only mode (no on-chain tx).
  // Tests in this file cover the algorithm/data pipeline, not on-chain submission.
  // On-chain submission behavior is tested in src/__tests__/keeper-rebalance.test.ts.
  keeperKeypairPath: '',
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

    // Both vaults have 3 backends (kamino-lending, marginfi-lending, lulo-lending)
    const moderateKeys = Object.keys(weights['moderate']!)
    expect(moderateKeys.length).toBe(3)

    const aggressiveKeys = Object.keys(weights['aggressive']!)
    expect(aggressiveKeys.length).toBe(3)
  })

  it('uses fallback yield data when Kamino API is unreachable', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const yieldData = keeper.getYieldData()
    expect(yieldData).not.toBeNull()
    // Fallback kamino rate + mock marginfi rate + fallback lulo rate
    expect(yieldData!.kaminoSupplyRate).toBe(0.021)
    expect(yieldData!.marginfiLendingRate).toBe(0.065)
    expect(yieldData!.luloRegularRate).toBe(0.07)
  })

  it('triggers alerter when Kamino rate fetch returns non-OK response', async () => {
    const alertSpy = vi.fn().mockResolvedValue(undefined)
    const keeperWithSpy = new Keeper({
      config: mockConfig,
      monitor: new HealthMonitor(),
    })
    // Inject spy alerter via a cast (alerter is private)
    ;(keeperWithSpy as unknown as { alerter: { alert: typeof alertSpy } }).alerter = { alert: alertSpy }

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('kamino')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      }
      if (typeof url === 'string' && url.includes('llama.fi')) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'success', data: [] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    await keeperWithSpy.runCycle()

    // Alerter should have been called at least once for the Kamino fallback
    const alertMessages = alertSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(alertMessages.some(m => m.includes('Kamino') || m.includes('fallback'))).toBe(true)

    keeperWithSpy.stop()
  })

  it('triggers alerter when Lulo rate fetch fails', async () => {
    const alertSpy = vi.fn().mockResolvedValue(undefined)
    const keeperWithSpy = new Keeper({
      config: { ...mockConfig, luloApiKey: 'test-key' },
      monitor: new HealthMonitor(),
    })
    ;(keeperWithSpy as unknown as { alerter: { alert: typeof alertSpy } }).alerter = { alert: alertSpy }

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('lulo.fi')) {
        return Promise.reject(new Error('Lulo API down'))
      }
      if (typeof url === 'string' && url.includes('llama.fi')) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'success', data: [] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    await keeperWithSpy.runCycle()

    const alertMessages = alertSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(alertMessages.some(m => m.includes('Lulo') || m.includes('fallback'))).toBe(true)

    keeperWithSpy.stop()
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
    expect(scan!.marketComparison).toBeDefined()
  })

  it('both vaults include kamino-lending, marginfi-lending, and lulo-lending backends', async () => {
    mockFetchForCycle()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    const aggressiveDecision = decisions.find(d => d.riskLevel === 'aggressive')
    expect(aggressiveDecision).toBeDefined()
    expect(aggressiveDecision!.proposal.scores['kamino-lending']).toBeDefined()
    expect(aggressiveDecision!.proposal.scores['marginfi-lending']).toBeDefined()
    expect(aggressiveDecision!.proposal.scores['lulo-lending']).toBeDefined()

    const moderateDecision = decisions.find(d => d.riskLevel === 'moderate')
    expect(moderateDecision).toBeDefined()
    expect(moderateDecision!.proposal.scores['kamino-lending']).toBeDefined()
    expect(moderateDecision!.proposal.scores['marginfi-lending']).toBeDefined()
    expect(moderateDecision!.proposal.scores['lulo-lending']).toBeDefined()
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

describe('AI cycle', () => {
  const originalFetchAI = globalThis.fetch

  function mockFetchForAICycle() {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('llama.fi')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'success', data: [] }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  }

  // fetchYieldData now calls fetchMarginfiRate which hits yields.llama.fi.
  // All AI cycle tests must have a fetch mock in place to avoid real network calls.
  beforeEach(() => {
    mockFetchForAICycle()
  })

  afterEach(() => {
    globalThis.fetch = originalFetchAI
  })

  it('stores AI insight when AI provider returns valid response', async () => {
    const mockAi = {
      isAvailable: true,
      analyze: vi.fn().mockResolvedValue(JSON.stringify({
        strategies: { 'kamino-lending': 0.9, 'marginfi-lending': 0.5 },
        risk_elevated: false,
        reasoning: 'Test insight.',
      })),
    }

    const keeper = new Keeper({
      config: { ...mockConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    const insight = keeper.getAIInsight()

    expect(insight).not.toBeNull()
    expect(insight?.strategies['kamino-lending']).toBe(0.9)
    expect(insight?.riskElevated).toBe(false)
    expect(mockAi.analyze).toHaveBeenCalledOnce()

    keeper.stop()
  })

  it('keeps stale insight when AI call fails', async () => {
    const mockAi = {
      isAvailable: true,
      analyze: vi.fn(),
    }

    const keeper = new Keeper({
      config: { ...mockConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    // First call succeeds
    mockAi.analyze.mockResolvedValueOnce(JSON.stringify({
      strategies: { 'kamino-lending': 0.9 },
      risk_elevated: false,
      reasoning: 'Good.',
    }))
    await keeper.runAICycle()
    expect(keeper.getAIInsight()).not.toBeNull()

    // Second call fails — stale insight preserved
    mockAi.analyze.mockRejectedValueOnce(new Error('fail'))
    await keeper.runAICycle()
    expect(keeper.getAIInsight()).not.toBeNull()
    expect(keeper.getAIInsight()?.strategies['kamino-lending']).toBe(0.9)

    keeper.stop()
  })

  it('skips AI cycle when provider is unavailable', async () => {
    const mockAi = {
      isAvailable: false,
      analyze: vi.fn(),
    }

    const keeper = new Keeper({
      config: { ...mockConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    expect(mockAi.analyze).not.toHaveBeenCalled()
    expect(keeper.getAIInsight()).toBeNull()

    keeper.stop()
  })

  it('includes AI insight in decisions', async () => {
    mockFetchForAICycle()

    const mockAi = {
      isAvailable: true,
      analyze: vi.fn().mockResolvedValue(JSON.stringify({
        strategies: { 'kamino-lending': 0.9, 'marginfi-lending': 0.8 },
        risk_elevated: false,
        reasoning: 'All stable.',
      })),
    }

    const keeper = new Keeper({
      config: { ...mockConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions[0]!.aiInsight).toBeDefined()
    expect(decisions[0]!.aiInsight?.reasoning).toBe('All stable.')

    keeper.stop()
  })
})
