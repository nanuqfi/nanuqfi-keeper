export interface YieldSource {
  name: string
  apy: number
  volatility: number
}

export interface RankedSource extends YieldSource {
  riskAdjustedScore: number
}

/**
 * Risk-adjusted return: APY divided by volatility floor.
 * Floor prevents division-by-zero for zero-volatility sources.
 */
export function computeRiskAdjustedScore(apy: number, volatility: number): number {
  if (apy <= 0) return 0
  return apy / Math.max(volatility, 0.001)
}

/**
 * Rank yield sources by descending risk-adjusted score.
 */
export function rankYieldSources(sources: YieldSource[]): RankedSource[] {
  return sources
    .map(s => ({ ...s, riskAdjustedScore: computeRiskAdjustedScore(s.apy, s.volatility) }))
    .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore)
}
