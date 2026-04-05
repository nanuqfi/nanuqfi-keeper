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
      { name: 'drift-basis', apy: 0.20, volatility: 0.05 },
      { name: 'drift-funding', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })

  it('allocates proportionally to risk-adjusted score', () => {
    // drift-basis: score = 0.20/0.05 = 4.0
    // drift-funding: score = 0.10/0.05 = 2.0
    // Expected allocation: 4/6 ≈ 6666 bps, 2/6 ≈ 3333 bps (+ remainder to highest)
    const state = makeState([
      { name: 'drift-basis', apy: 0.20, volatility: 0.05 },
      { name: 'drift-funding', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    const basisBps = proposal.weights['drift-basis']!
    const fundingBps = proposal.weights['drift-funding']!
    // drift-basis should get roughly 2× drift-funding
    expect(basisBps).toBeGreaterThan(fundingBps)
    // Exact: floor(4/6*10000)=6666, floor(2/6*10000)=3333, remainder=1 → basis gets 6667
    expect(basisBps).toBe(6667)
    expect(fundingBps).toBe(3333)
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
      { name: 'drift-basis', apy: 0.20, volatility: 0.05 },
      { name: 'drift-funding', apy: 0.10, volatility: 0.05 },
    ])
    const proposal = engine.propose(state)
    expect(proposal.scores['drift-basis']).toBeGreaterThan(0)
    expect(proposal.scores['drift-funding']).toBeGreaterThan(0)
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
  it('excludes a backend that triggers auto-exit', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        {
          name: 'drift-basis',
          apy: 0.20,
          volatility: 0.05,
          // 16 consecutive negative funding entries → triggers basis exit
          autoExitContext: { fundingHistory: Array(16).fill(-0.001) },
        },
        {
          name: 'drift-funding',
          apy: 0.10,
          volatility: 0.05,
          autoExitContext: {},
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toContain('drift-basis')
    expect(proposal.weights['drift-basis']).toBeUndefined()
    expect(proposal.weights['drift-funding']).toBe(10_000)
    expect(sumWeights(proposal.weights)).toBe(10_000)
  })

  it('returns empty weights when all backends are excluded', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        {
          name: 'drift-basis',
          apy: 0.20,
          volatility: 0.05,
          autoExitContext: { fundingHistory: Array(16).fill(-0.001) },
        },
        {
          name: 'drift-insurance',
          apy: 0.08,
          volatility: 0.02,
          autoExitContext: { insuranceFundDrawdown: 0.40 },
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toHaveLength(2)
    expect(Object.keys(proposal.weights)).toHaveLength(0)
    expect(sumWeights(proposal.weights)).toBe(0)
  })

  it('includes auto-exited backend scores in the scores map for audit', () => {
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        {
          name: 'drift-basis',
          apy: 0.20,
          volatility: 0.05,
          autoExitContext: { fundingHistory: Array(16).fill(-0.001) },
        },
        {
          name: 'drift-funding',
          apy: 0.10,
          volatility: 0.05,
          autoExitContext: {},
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    // Score for excluded backend must still be present
    expect(proposal.scores['drift-basis']).toBeDefined()
    expect(proposal.scores['drift-basis']).toBeGreaterThan(0)
  })

  it('uses vault riskLevel when autoExitContext does not specify one', () => {
    // drift-funding with aggressive vault risk, PnL at -3% — should NOT exit
    const state: VaultState = {
      riskLevel: 'aggressive',
      backends: [
        {
          name: 'drift-funding',
          apy: 0.10,
          volatility: 0.05,
          // No riskLevel in context — engine should inherit vault riskLevel
          autoExitContext: { unrealizedPnlPercent: -0.03 },
        },
      ],
      currentWeights: {},
    }
    const proposal = engine.propose(state)
    expect(proposal.excludedBackends).toHaveLength(0)
    expect(proposal.weights['drift-funding']).toBe(10_000)
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
        name: 'drift-lending',
        apy: 0.02,
        volatility: 0.05,
        autoExitContext: { riskLevel: 'moderate' },
      },
      {
        name: 'drift-basis',
        apy: 0.15,
        volatility: 0.20,
        autoExitContext: { riskLevel: 'moderate' },
      },
    ],
    currentWeights: {},
  }

  it('applies AI confidence multipliers to scores', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 0.5 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withAi = engine.propose(baseState, insight)
    const withoutAi = engine.propose(baseState)

    expect(withAi.weights['drift-lending']).toBeGreaterThan(withoutAi.weights['drift-lending']!)
    expect(withAi.weights['drift-basis']).toBeLessThan(withoutAi.weights['drift-basis']!)
  })

  it('dampens perp scores when riskElevated is true', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 1.0 },
      riskElevated: true,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRisk = engine.propose(baseState, insight)
    const withoutRisk = engine.propose(baseState)

    expect(withRisk.weights['drift-lending']).toBeGreaterThan(withoutRisk.weights['drift-lending']!)
    expect(withRisk.weights['drift-basis']).toBeLessThan(withoutRisk.weights['drift-basis']!)
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
      strategies: { 'drift-lending': 1.0 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    expect(result.weights['drift-basis']).toBeGreaterThan(0)
  })

  it('excludes backend when AI confidence is 0', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 0.0 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    expect(result.weights['drift-basis']).toBe(0)
    expect(result.weights['drift-lending']).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Phase 1C — AI regime detection multipliers
// ---------------------------------------------------------------------------

describe('AI regime detection multipliers', () => {
  const baseState: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'drift-lending', apy: 0.05, volatility: 0.05, autoExitContext: {} },
      { name: 'drift-basis', apy: 0.15, volatility: 0.10, autoExitContext: {} },
      { name: 'drift-funding', apy: 0.10, volatility: 0.15, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('stress regime boosts lending and dampens perps', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 1.0, 'drift-funding': 1.0 },
      riskElevated: false,
      regime: 'stress',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Stress: lending ×1.5, perps ×0.3
    expect(withRegime.weights['drift-lending']!).toBeGreaterThan(withoutRegime.weights['drift-lending']!)
    expect(withRegime.weights['drift-basis']!).toBeLessThan(withoutRegime.weights['drift-basis']!)
  })

  it('trend regime boosts funding and dampens basis', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 1.0, 'drift-funding': 1.0 },
      riskElevated: false,
      regime: 'trend',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Trend: funding ×1.3, basis ×0.7
    expect(withRegime.weights['drift-funding']!).toBeGreaterThan(withoutRegime.weights['drift-funding']!)
    expect(withRegime.weights['drift-basis']!).toBeLessThan(withoutRegime.weights['drift-basis']!)
  })

  it('range regime boosts lending and basis scores, dampens funding score', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 1.0, 'drift-funding': 1.0 },
      riskElevated: false,
      regime: 'range',
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRegime = engine.propose(baseState, insight)
    const noRegime: AIInsight = { ...insight, regime: undefined }
    const withoutRegime = engine.propose(baseState, noRegime)

    // Range: lending ×1.2, basis ×1.2, funding ×0.5 — check scores directly
    expect(withRegime.scores['drift-lending']!).toBeGreaterThan(withoutRegime.scores['drift-lending']!)
    expect(withRegime.scores['drift-basis']!).toBeGreaterThan(withoutRegime.scores['drift-basis']!)
    expect(withRegime.scores['drift-funding']!).toBeLessThan(withoutRegime.scores['drift-funding']!)
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
      makeOpp('Drift', 0.02, 'low'),
    ],
    bestByRisk: {
      low: makeOpp('Kamino', 0.08, 'low'),
      medium: makeOpp('Marginfi', 0.12, 'medium'),
      high: null,
    },
    driftComparison: { driftBestApy: 0.02, marketBestApy: 0.12, driftRank: 3, totalScanned: 3 },
    ...overrides,
  }
}

describe('Market scan opportunity cost penalty', () => {
  const stateWith2Backends: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'drift-lending', apy: 0.02, volatility: 0.05, autoExitContext: {} },
      { name: 'drift-basis', apy: 0.05, volatility: 0.20, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('applies penalty when external best APY > 2x backend APY for same risk tier', () => {
    const engine = new AlgorithmEngine()
    // Kamino low-risk at 8% vs drift-lending at 2% → 4x → penalty
    const scan = makeMarketScan()
    const withScan = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    const withoutScan = engine.propose(stateWith2Backends)

    // drift-lending should get a lower score with scan (penalized)
    expect(withScan.scores['drift-lending']!).toBeLessThan(withoutScan.scores['drift-lending']!)
  })

  it('does not penalize when external best APY < 2x backend APY', () => {
    const engine = new AlgorithmEngine()
    // drift-basis at 5% medium risk, external medium best at 12% → 2.4x → penalty
    // But let's make external only 8% → 1.6x → no penalty
    const scan = makeMarketScan({
      bestByRisk: {
        low: { protocol: 'Kamino', strategy: 'Kamino Lending', asset: 'USDC', apy: 0.03, tvl: 1_000_000, risk: 'low', source: 'defillama' },
        medium: { protocol: 'Marginfi', strategy: 'Marginfi Lending', asset: 'USDC', apy: 0.08, tvl: 1_000_000, risk: 'medium', source: 'defillama' },
        high: null,
      },
    })

    const withScan = engine.propose(stateWith2Backends, undefined, { marketScan: scan })
    const withoutScan = engine.propose(stateWith2Backends)

    // drift-basis at 5% vs external 8% = 1.6x → no penalty
    expect(withScan.scores['drift-basis']!).toBe(withoutScan.scores['drift-basis']!)
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

describe('Correlation-aware position sizing', () => {
  it('caps perp allocation for moderate vaults at 60%', () => {
    const engine = new AlgorithmEngine()
    // All high-APY perps should dominate, but perp cap should limit them
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'drift-lending', apy: 0.02, volatility: 0.05, autoExitContext: {} },
        { name: 'drift-basis', apy: 0.30, volatility: 0.10, autoExitContext: {} },
        { name: 'drift-jito-dn', apy: 0.25, volatility: 0.10, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    const perpBps = (result.weights['drift-basis'] ?? 0) + (result.weights['drift-jito-dn'] ?? 0)
    expect(perpBps).toBeLessThanOrEqual(6000)
    expect(result.weights['drift-lending']!).toBeGreaterThanOrEqual(4000)
    expect(sumWeights(result.weights)).toBe(10_000)
  })

  it('caps perp allocation for aggressive vaults at 70%', () => {
    const engine = new AlgorithmEngine()
    const state: VaultState = {
      riskLevel: 'aggressive',
      backends: [
        { name: 'drift-lending', apy: 0.02, volatility: 0.05, autoExitContext: {} },
        { name: 'drift-basis', apy: 0.30, volatility: 0.10, autoExitContext: {} },
        { name: 'drift-funding', apy: 0.25, volatility: 0.15, autoExitContext: {} },
        { name: 'drift-jito-dn', apy: 0.20, volatility: 0.10, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    const perpBps = (result.weights['drift-basis'] ?? 0)
      + (result.weights['drift-funding'] ?? 0)
      + (result.weights['drift-jito-dn'] ?? 0)
    expect(perpBps).toBeLessThanOrEqual(7000)
    expect(sumWeights(result.weights)).toBe(10_000)
  })

  it('does not cap when perp allocation is within limits', () => {
    const engine = new AlgorithmEngine()
    // lending dominates → perp allocation naturally low
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'drift-lending', apy: 0.50, volatility: 0.05, autoExitContext: {} },
        { name: 'drift-basis', apy: 0.02, volatility: 0.20, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const result = engine.propose(state)
    // lending should get ~99% naturally, no capping needed
    expect(result.weights['drift-lending']!).toBeGreaterThan(9000)
    expect(sumWeights(result.weights)).toBe(10_000)
  })

  it('redistributes excess perp to drift-lending', () => {
    const engine = new AlgorithmEngine()
    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'drift-lending', apy: 0.01, volatility: 0.05, autoExitContext: {} },
        { name: 'drift-basis', apy: 0.40, volatility: 0.10, autoExitContext: {} },
        { name: 'drift-jito-dn', apy: 0.35, volatility: 0.10, autoExitContext: {} },
      ],
      currentWeights: {},
    }

    const withoutLending = engine.propose({
      ...state,
      backends: state.backends.filter(b => b.name !== 'drift-lending'),
    })
    const withLending = engine.propose(state)

    // With lending present, it should absorb the overflow from perp cap
    expect(withLending.weights['drift-lending']!).toBeGreaterThanOrEqual(4000)
  })
})

// ---------------------------------------------------------------------------
// Phase 2A — Oracle divergence dampening
// ---------------------------------------------------------------------------

describe('Oracle divergence dampening', () => {
  const stateWithPerps: VaultState = {
    riskLevel: 'moderate',
    backends: [
      { name: 'drift-lending', apy: 0.05, volatility: 0.05, autoExitContext: {} },
      { name: 'drift-basis', apy: 0.15, volatility: 0.10, autoExitContext: {} },
    ],
    currentWeights: {},
  }

  it('dampens SOL-exposed strategies when oracle deviation > 1%', () => {
    const engine = new AlgorithmEngine()
    const normal = engine.propose(stateWithPerps)
    const dampened = engine.propose(stateWithPerps, undefined, {
      oracleDeviation: { SOL: 0.015 },
    })

    // drift-basis is SOL-exposed, should get lower score
    expect(dampened.scores['drift-basis']!).toBeLessThan(normal.scores['drift-basis']!)
    // drift-lending is NOT SOL-exposed, should be unaffected
    expect(dampened.scores['drift-lending']!).toBe(normal.scores['drift-lending']!)
  })

  it('applies severe dampening when oracle deviation > 3%', () => {
    const engine = new AlgorithmEngine()
    const mild = engine.propose(stateWithPerps, undefined, {
      oracleDeviation: { SOL: 0.015 },
    })
    const severe = engine.propose(stateWithPerps, undefined, {
      oracleDeviation: { SOL: 0.04 },
    })

    expect(severe.scores['drift-basis']!).toBeLessThan(mild.scores['drift-basis']!)
  })

  it('does not dampen when deviation < 1%', () => {
    const engine = new AlgorithmEngine()
    const normal = engine.propose(stateWithPerps)
    const noDampening = engine.propose(stateWithPerps, undefined, {
      oracleDeviation: { SOL: 0.005 },
    })

    expect(noDampening.scores['drift-basis']!).toBe(normal.scores['drift-basis']!)
  })
})

// ---------------------------------------------------------------------------
// Phase 2B — Predictive auto-exit (funding slope dampening)
// ---------------------------------------------------------------------------

describe('Funding slope dampening', () => {
  it('dampens drift-basis when funding slope is strongly negative and funding near zero', () => {
    const engine = new AlgorithmEngine()
    // Declining funding: 5bps → 4bps → 3bps → 2bps → 1.5bps → 1bps → 0.5bps → 0.2bps
    const decliningHistory = [0.0005, 0.0004, 0.0003, 0.0002, 0.00015, 0.0001, 0.00005, 0.00002]

    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'drift-lending', apy: 0.02, volatility: 0.05, autoExitContext: {} },
        {
          name: 'drift-basis',
          apy: 0.10,
          volatility: 0.10,
          autoExitContext: { fundingHistory: decliningHistory },
        },
      ],
      currentWeights: {},
    }

    const normal = engine.propose({
      ...state,
      backends: state.backends.map(b =>
        b.name === 'drift-basis'
          ? { ...b, autoExitContext: { fundingHistory: [0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001] } }
          : b
      ),
    })
    const dampened = engine.propose(state)

    expect(dampened.scores['drift-basis']!).toBeLessThan(normal.scores['drift-basis']!)
  })

  it('does not dampen when funding slope is flat or positive', () => {
    const engine = new AlgorithmEngine()
    const flatHistory = [0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001]

    const state: VaultState = {
      riskLevel: 'moderate',
      backends: [
        { name: 'drift-lending', apy: 0.02, volatility: 0.05, autoExitContext: {} },
        {
          name: 'drift-basis',
          apy: 0.10,
          volatility: 0.10,
          autoExitContext: { fundingHistory: flatHistory },
        },
      ],
      currentWeights: {},
    }

    const normal = engine.propose({
      ...state,
      backends: state.backends.map(b =>
        b.name === 'drift-basis' ? { ...b, autoExitContext: {} } : b
      ),
    })
    const result = engine.propose(state)

    // Scores should be equal — no dampening applied
    expect(result.scores['drift-basis']!).toBe(normal.scores['drift-basis']!)
  })
})
