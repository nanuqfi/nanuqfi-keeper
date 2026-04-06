import { describe, it, expect } from 'vitest'
import { AlgorithmEngine, type VaultState } from './algorithm-engine.js'
import type { AIInsight } from '../ai/index.js'
import type { MarketScan, YieldOpportunity } from '../scanner/index.js'

function sumWeights(weights: Record<string, number>): number {
  return Object.values(weights).reduce((sum, w) => sum + w, 0)
}

const engine = new AlgorithmEngine()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a VaultState with backends that have no auto-exit triggers. */
function makeState(
  backends: Array<{ name: string; apy: number; volatility: number }>,
  riskLevel = 'moderate'
): VaultState {
  return {
    riskLevel,
    backends: backends.map(b => ({
      ...b,
      autoExitContext: {},
    })),
    currentWeights: {},
  }
}

// ---------------------------------------------------------------------------
// Basic allocation
// ---------------------------------------------------------------------------
describe('AlgorithmEngine.propose — basic allocation', () => {
  it('weights sum to 10 000 bps for two healthy backends', () => {
    const state = makeState([
      { name: 'kamino-lending', apy: 0.20, volatility: 0.05 },
      { name: 'marginfi-lending', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })

  it('allocates proportionally to risk-adjusted score', () => {
    // kamino-lending: score = 0.20/0.05 = 4.0
    // marginfi-lending: score = 0.10/0.05 = 2.0
    // Expected allocation: 4/6 ≈ 6666 bps, 2/6 ≈ 3333 bps (+ remainder to highest)
    const state = makeState([
      { name: 'kamino-lending', apy: 0.20, volatility: 0.05 },
      { name: 'marginfi-lending', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    const kaminoBps = proposal.weights['kamino-lending']!
    const marginfiBps = proposal.weights['marginfi-lending']!
    // kamino-lending should get roughly 2x marginfi-lending
    expect(kaminoBps).toBeGreaterThan(marginfiBps)
    // Exact: floor(4/6*10000)=6666, floor(2/6*10000)=3333, remainder=1 → kamino gets 6667
    expect(kaminoBps).toBe(6667)
    expect(marginfiBps).toBe(3333)
  })

  it('weights sum to 10 000 for three backends', () => {
    const state = makeState([
      { name: 'a', apy: 0.15, volatility: 0.05 },
      { name: 'b', apy: 0.10, volatility: 0.04 },
      { name: 'c', apy: 0.08, volatility: 0.03 },
    ])
    const proposal = engine.propose(state)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })

  it('includes scores for all backends', () => {
    const state = makeState([
      { name: 'kamino-lending', apy: 0.20, volatility: 0.05 },
      { name: 'marginfi-lending', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    expect(proposal.scores['kamino-lending']).toBeGreaterThan(0)
    expect(proposal.scores['marginfi-lending']).toBeGreaterThan(0)
  })

  it('gives a single surviving backend 100% (10 000 bps)', () => {
    const state = makeState([{ name: 'solo', apy: 0.15, volatility: 0.05 }])
    const proposal = engine.propose(state)
    expect(proposal.weights['solo']).toBe(10_000)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Auto-exit exclusion
// ---------------------------------------------------------------------------
describe('AlgorithmEngine.propose — auto-exit exclusion', () => {
  it('does not exclude lending backends (no auto-exit triggers for lending)', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        {
          name: 'kamino-lending',
          apy: 0.02,
          volatility: 0.03,
          autoExitContext: { riskLevel: 'moderate' },
        },
        {
          name: 'marginfi-lending',
          apy: 0.065,
          volatility: 0.04,
          autoExitContext: { riskLevel: 'moderate' },
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toHaveLength(0)
    expect(proposal.weights['kamino-lending']).toBeDefined()
    expect(proposal.weights['marginfi-lending']).toBeDefined()
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })

  it('returns empty weights when there are no backends', () => {
    // Empty backends list — no allocation possible
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toHaveLength(0)
    expect(Object.keys(proposal.weights)).toHaveLength(0)
    expect(sumWeights(proposal.weights)).toBe(0)
  })

  it('includes scores for all backends in the scores map for audit', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        {
          name: 'kamino-lending',
          apy: 0.02,
          volatility: 0.03,
          autoExitContext: { riskLevel: 'moderate' },
        },
        {
          name: 'marginfi-lending',
          apy: 0.065,
          volatility: 0.04,
          autoExitContext: { riskLevel: 'moderate' },
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.scores['kamino-lending']).toBeDefined()
    expect(proposal.scores['kamino-lending']).toBeGreaterThan(0)
    expect(proposal.scores['marginfi-lending']).toBeDefined()
    expect(proposal.scores['marginfi-lending']).toBeGreaterThan(0)
  })

  it('uses vault riskLevel when autoExitContext does not specify one', () => {
    const state: VaultState = {
      riskLevel: 'aggressive',
      backends: [
        {
          name: 'kamino-lending',
          apy: 0.02,
          volatility: 0.03,
          autoExitContext: {},
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toHaveLength(0)
    expect(proposal.weights['kamino-lending']).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('AlgorithmEngine.propose — edge cases', () => {
  it('handles empty backends array', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(Object.keys(proposal.weights)).toHaveLength(0)
    expect(proposal.excludedBackends).toHaveLength(0)
    expect(sumWeights(proposal.weights)).toBe(0)
  })

  it('distributes equally when all surviving backends have zero APY', () => {
    const state = makeState([
      { name: 'a', apy: 0, volatility: 0.05 },
      { name: 'b', apy: 0, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// AI-blended scoring
// ---------------------------------------------------------------------------
describe('AI-blended scoring', () => {
  const baseState: VaultState = {
    riskLevel: 'moderate',
    backends: [
      {
        name: 'kamino-lending',
        apy: 0.02,
        volatility: 0.03,
        autoExitContext: { riskLevel: 'moderate' },
      },
      {
        name: 'marginfi-lending',
        apy: 0.065,
        volatility: 0.04,
        autoExitContext: { riskLevel: 'moderate' },
      },
    ],
    currentWeights: {},
  }

  it('applies AI confidence multipliers to scores', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 0.5 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withAi = engine.propose(baseState, insight)
    const withoutAi = engine.propose(baseState)

    expect(withAi.weights['kamino-lending']).toBeGreaterThan(withoutAi.weights['kamino-lending']!)
    expect(withAi.weights['marginfi-lending']).toBeLessThan(withoutAi.weights['marginfi-lending']!)
  })

  it('riskElevated has no effect on lending-only backends (no perps)', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 1.0 },
      riskElevated: true,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRisk = engine.propose(baseState, insight)
    const insightNoRisk: AIInsight = { ...insight, riskElevated: false }
    const withoutRisk = engine.propose(baseState, insightNoRisk)

    // With no perps, riskElevated should not change weights
    expect(withRisk.weights['kamino-lending']).toBe(withoutRisk.weights['kamino-lending']!)
    expect(withRisk.weights['marginfi-lending']).toBe(withoutRisk.weights['marginfi-lending']!)
  })

  it('defaults to 1.0 when AI insight is undefined', () => {
    const engine = new AlgorithmEngine()
    const without = engine.propose(baseState)
    const withNull = engine.propose(baseState, undefined)
    expect(without.weights).toEqual(withNull.weights)
  })

  it('defaults to 1.0 for strategies not in AI insight', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    expect(result.weights['marginfi-lending']).toBeGreaterThan(0)
  })

  it('excludes backend when AI confidence is 0', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 0.0 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    expect(result.weights['marginfi-lending']).toBe(0)
    expect(result.weights['kamino-lending']).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Phase 1C — AI regime detection multipliers
// ---------------------------------------------------------------------------

describe('AI regime detection multipliers', () => {
  const baseState: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
      { name: 'marginfi-lending', apy: 0.065, volatility: 0.04, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('stress regime boosts lending scores (both backends)', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 1.0 },
      riskElevated: false,
      regime: 'stress',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Stress: both lending backends ×1.5
    expect(withRegime.scores['kamino-lending']!).toBeGreaterThan(withoutRegime.scores['kamino-lending']!)
    expect(withRegime.scores['marginfi-lending']!).toBeGreaterThan(withoutRegime.scores['marginfi-lending']!)
  })

  it('trend regime keeps lending scores unchanged (multiplier 1.0)', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 1.0 },
      riskElevated: false,
      regime: 'trend',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Trend: lending backends ×1.0 — no change
    expect(withRegime.scores['kamino-lending']!).toBe(withoutRegime.scores['kamino-lending']!)
    expect(withRegime.scores['marginfi-lending']!).toBe(withoutRegime.scores['marginfi-lending']!)
  })

  it('range regime boosts lending scores (×1.2)', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'kamino-lending': 1.0, 'marginfi-lending': 1.0 },
      riskElevated: false,
      regime: 'range',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Range: both lending backends ×1.2
    expect(withRegime.scores['kamino-lending']!).toBeGreaterThan(withoutRegime.scores['kamino-lending']!)
    expect(withRegime.scores['marginfi-lending']!).toBeGreaterThan(withoutRegime.scores['marginfi-lending']!)
  })
})

// ---------------------------------------------------------------------------
// Phase 1A — Market scan opportunity cost penalty
// ---------------------------------------------------------------------------

function makeMarketScan(overrides: Partial<MarketScan> = {}): MarketScan {
  const makeOpp = (protocol: string, apy: number, risk: 'low' | 'medium' | 'high'): YieldOpportunity => ({
    protocol,
    strategy: `${protocol} Lending`,
    asset: 'USDC',
    apy,
    tvl: 1_000_000,
    risk,
    source: 'defillama',
  })

  return {
    timestamp: Date.now(),
    opportunities: [
      makeOpp('Kamino', 0.08, 'low'),
      makeOpp('Marginfi', 0.12, 'medium'),
      makeOpp('Lulo', 0.05, 'low'),
    ],
    bestByRisk: {
      low: makeOpp('Kamino', 0.08, 'low'),
      medium: makeOpp('Marginfi', 0.12, 'medium'),
      high: null,
    },
    driftComparison: { driftBestApy: 0, marketBestApy: 0.12, driftRank: 4, totalScanned: 3 },
    ...overrides,
  }
}

describe('Market scan opportunity cost penalty', () => {
  const stateWith2Backends: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
      { name: 'marginfi-lending', apy: 0.065, volatility: 0.04, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('applies penalty when external best APY > 2x backend APY for same risk tier', () => {
    const engine = new AlgorithmEngine()
    // External low-risk at 8% vs kamino-lending at 2% → 4x → penalty
    const scan = makeMarketScan()
    const withScan = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    const withoutScan = engine.propose(stateWith2Backends)

    // kamino-lending should get a lower score with scan (penalized)
    expect(withScan.scores['kamino-lending']!).toBeLessThan(withoutScan.scores['kamino-lending']!)
  })

  it('does not penalize when external best APY < 2x backend APY', () => {
    const engine = new AlgorithmEngine()
    // marginfi-lending at 6.5% low risk, external low best at 3% → 0.46x → no penalty
    const scan = makeMarketScan({
      bestByRisk: {
        low: { protocol: 'SomeProtocol', strategy: 'USDC Lending', asset: 'USDC', apy: 0.03, tvl: 1_000_000, risk: 'low', source: 'defillama' },
        medium: null,
        high: null,
      },
    })

    const withScan = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    const withoutScan = engine.propose(stateWith2Backends)

    // marginfi-lending at 6.5% vs external 3% = 0.46x → no penalty
    expect(withScan.scores['marginfi-lending']!).toBe(withoutScan.scores['marginfi-lending']!)
  })

  it('still sums weights to 10 000 with market scan', () => {
    const engine = new AlgorithmEngine()
    const scan = makeMarketScan()
    const result = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    expect(sumWeights(result.weights)).toBe(10_000)
  })

  it('handles missing bestByRisk entries gracefully', () => {
    const engine = new AlgorithmEngine()
    const scan = makeMarketScan({
      bestByRisk: { low: null, medium: null, high: null },
    })
    const result = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    expect(sumWeights(result.weights)).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Phase 1B — Correlation-aware position sizing (perp cap)
// ---------------------------------------------------------------------------

describe('Correlation-aware position sizing (lending-only, no perp cap)', () => {
  it('does not apply perp cap with lending-only backends', () => {
    const engine = new AlgorithmEngine()
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
        { name: 'marginfi-lending', apy: 0.065, volatility: 0.04, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    // No perp strategies → no cap applied, allocation is purely proportional
    expect(sumWeights(result.weights)).toBe(10_000)
    // marginfi has higher risk-adjusted score, should get more
    expect(result.weights['marginfi-lending']!).toBeGreaterThan(result.weights['kamino-lending']!)
  })

  it('allocates proportionally to risk-adjusted scores without capping', () => {
    const engine = new AlgorithmEngine()
    const state: VaultState = {
      riskLevel: 'aggressive',
      backends: [
        { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
        { name: 'marginfi-lending', apy: 0.065, volatility: 0.04, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    expect(sumWeights(result.weights)).toBe(10_000)
    // Both backends get allocation, no cap interference
    expect(result.weights['kamino-lending']!).toBeGreaterThan(0)
    expect(result.weights['marginfi-lending']!).toBeGreaterThan(0)
  })

  it('single backend gets 100% when it dominates', () => {
    const engine = new AlgorithmEngine()
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'kamino-lending', apy: 0.50, volatility: 0.03, autoExitContext: {} },
        { name: 'marginfi-lending', apy: 0.001, volatility: 0.04, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    expect(result.weights['kamino-lending']!).toBeGreaterThan(9000)
    expect(sumWeights(result.weights)).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Phase 2A — Oracle divergence dampening
// ---------------------------------------------------------------------------

describe('Oracle divergence dampening (lending-only — no SOL-exposed strategies)', () => {
  const stateWithLending: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
      { name: 'marginfi-lending', apy: 0.065, volatility: 0.04, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('does not dampen lending backends regardless of oracle deviation', () => {
    const engine = new AlgorithmEngine()
    const normal = engine.propose(stateWithLending)
    const withDeviation = engine.propose(stateWithLending, undefined, {
      oracleDeviation: { SOL: 0.05 },
    })

    // Lending backends are NOT SOL-exposed, scores should be identical
    expect(withDeviation.scores['kamino-lending']!).toBe(normal.scores['kamino-lending']!)
    expect(withDeviation.scores['marginfi-lending']!).toBe(normal.scores['marginfi-lending']!)
  })

  it('weights remain unchanged with extreme oracle deviation', () => {
    const engine = new AlgorithmEngine()
    const normal = engine.propose(stateWithLending)
    const extreme = engine.propose(stateWithLending, undefined, {
      oracleDeviation: { SOL: 0.10 },
    })

    expect(extreme.weights).toEqual(normal.weights)
  })
})

// ---------------------------------------------------------------------------
// Phase 2B — Predictive auto-exit (funding slope dampening)
// ---------------------------------------------------------------------------

describe('Funding slope dampening (no longer applicable with lending-only backends)', () => {
  it('lending backends are unaffected by funding history in context', () => {
    const engine = new AlgorithmEngine()
    const decliningHistory = [0.0005, 0.0004, 0.0003, 0.0002, 0.00015, 0.0001, 0.00005, 0.00002]

    const stateWithHistory: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'kamino-lending', apy: 0.02, volatility: 0.03, autoExitContext: {} },
        {
          name: 'marginfi-lending',
          apy: 0.065,
          volatility: 0.04,
          autoExitContext: { riskLevel: 'moderate' },
        },
      ],
      currentWeights: {},
    }

    const stateWithout: VaultState = {
      ...stateWithHistory,
      backends: stateWithHistory.backends.map(b => ({
        ...b,
        autoExitContext: {},
      })),
    }

    const withHistory = engine.propose(stateWithHistory)
    const withoutHistory = engine.propose(stateWithout)

    // Scores should be identical — funding slope is not applied to lending backends
    expect(withHistory.scores['marginfi-lending']!).toBe(withoutHistory.scores['marginfi-lending']!)
  })
})
