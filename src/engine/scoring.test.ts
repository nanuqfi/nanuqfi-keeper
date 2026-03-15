import { describe, it, expect } from 'vitest'
import { computeRiskAdjustedScore, rankYieldSources, type YieldSource } from './scoring.js'

describe('computeRiskAdjustedScore', () => {
  it('returns higher score for higher APY at same volatility', () => {
    const scoreHigh = computeRiskAdjustedScore(0.20, 0.05)
    const scoreLow = computeRiskAdjustedScore(0.10, 0.05)
    expect(scoreHigh).toBeGreaterThan(scoreLow)
  })

  it('returns higher score for lower volatility at same APY', () => {
    const scoreLowVol = computeRiskAdjustedScore(0.10, 0.02)
    const scoreHighVol = computeRiskAdjustedScore(0.10, 0.10)
    expect(scoreLowVol).toBeGreaterThan(scoreHighVol)
  })

  it('returns finite result when volatility is zero (no div-by-zero)', () => {
    const score = computeRiskAdjustedScore(0.10, 0)
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
  })

  it('returns 0 when APY is zero', () => {
    expect(computeRiskAdjustedScore(0, 0.05)).toBe(0)
  })

  it('returns 0 when APY is negative', () => {
    expect(computeRiskAdjustedScore(-0.05, 0.05)).toBe(0)
  })

  it('uses volatility floor of 0.001 for near-zero volatility', () => {
    const atFloor = computeRiskAdjustedScore(0.10, 0.001)
    const belowFloor = computeRiskAdjustedScore(0.10, 0.0001)
    // Both should use the same floor → same score
    expect(atFloor).toBeCloseTo(belowFloor, 10)
  })
})

describe('rankYieldSources', () => {
  const sources: YieldSource[] = [
    { name: 'drift-funding', apy: 0.12, volatility: 0.08 },
    { name: 'drift-basis', apy: 0.20, volatility: 0.06 },
    { name: 'drift-insurance', apy: 0.08, volatility: 0.02 },
  ]

  it('returns array of same length with riskAdjustedScore attached', () => {
    const ranked = rankYieldSources(sources)
    expect(ranked).toHaveLength(sources.length)
    ranked.forEach(r => {
      expect(typeof r.riskAdjustedScore).toBe('number')
    })
  })

  it('sorts by descending risk-adjusted score', () => {
    const ranked = rankYieldSources(sources)
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i]!.riskAdjustedScore).toBeGreaterThanOrEqual(ranked[i + 1]!.riskAdjustedScore)
    }
  })

  it('does not mutate the original sources array', () => {
    const copy = sources.map(s => ({ ...s }))
    rankYieldSources(sources)
    expect(sources).toEqual(copy)
  })

  it('handles an empty array', () => {
    expect(rankYieldSources([])).toEqual([])
  })

  it('handles a single source', () => {
    const ranked = rankYieldSources([{ name: 'solo', apy: 0.10, volatility: 0.05 }])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]!.riskAdjustedScore).toBeCloseTo(2, 5)
  })

  it('places zero-APY sources at the bottom', () => {
    const mixed: YieldSource[] = [
      { name: 'good', apy: 0.10, volatility: 0.05 },
      { name: 'zero', apy: 0, volatility: 0.01 },
      { name: 'negative', apy: -0.01, volatility: 0.01 },
    ]
    const ranked = rankYieldSources(mixed)
    expect(ranked[0]!.name).toBe('good')
    // zero and negative both score 0 — order between them is stable enough
    const lastTwo = ranked.slice(1).map(r => r.riskAdjustedScore)
    lastTwo.forEach(s => expect(s).toBe(0))
  })
})
