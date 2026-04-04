import { describe, it, expect } from 'vitest'
import { AlgorithmEngine, type VaultState } from './algorithm-engine.js'
import type { AIInsight } from '../ai/index.js'

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
