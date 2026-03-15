import { computeRiskAdjustedScore, type YieldSource } from './scoring.js'
import { checkAutoExit, type AutoExitContext } from './auto-exit.js'

export interface BackendConfig {
  name: string
  apy: number
  volatility: number
  autoExitContext: AutoExitContext
}

export interface VaultState {
  riskLevel: string
  backends: BackendConfig[]
  /** Current allocations in basis points (0–10 000). Informational only — not used in scoring. */
  currentWeights: Record<string, number>
}

export interface WeightProposal {
  /** Proposed allocations in basis points (sum = 10 000, or 0 if all excluded). */
  weights: Record<string, number>
  /** Backends removed due to auto-exit triggers. */
  excludedBackends: string[]
  /** Risk-adjusted scores for every backend (including excluded ones for audit trail). */
  scores: Record<string, number>
}

/**
 * Deterministic algorithm engine.
 *
 * Each cycle:
 *  1. Evaluate auto-exit for every backend.
 *  2. Score the surviving backends.
 *  3. Allocate proportionally to risk-adjusted score, rounding to whole bps.
 *     Any rounding remainder is added to the highest-scoring backend.
 */
export class AlgorithmEngine {
  propose(state: VaultState): WeightProposal {
    const excluded: string[] = []
    const scores: Record<string, number> = {}

    // Step 1 — auto-exit check + scoring for all backends
    const surviving: Array<BackendConfig & { score: number }> = []

    for (const backend of state.backends) {
      const exitResult = checkAutoExit(backend.name, {
        ...backend.autoExitContext,
        riskLevel: backend.autoExitContext.riskLevel ?? state.riskLevel,
      })

      const score = computeRiskAdjustedScore(backend.apy, backend.volatility)
      scores[backend.name] = score

      if (exitResult.shouldExit) {
        excluded.push(backend.name)
      } else {
        surviving.push({ ...backend, score })
      }
    }

    // Step 2 — nothing survives
    if (surviving.length === 0) {
      return { weights: {}, excludedBackends: excluded, scores }
    }

    // Step 3 — proportional allocation in basis points
    const totalScore = surviving.reduce((sum, b) => sum + b.score, 0)

    if (totalScore === 0) {
      // All surviving backends scored 0 (e.g. all APY ≤ 0) — distribute equally
      const equalShare = Math.floor(10_000 / surviving.length)
      const remainder = 10_000 - equalShare * surviving.length
      const weights: Record<string, number> = {}
      surviving.forEach((b, i) => {
        weights[b.name] = equalShare + (i === 0 ? remainder : 0)
      })
      return { weights, excludedBackends: excluded, scores }
    }

    const rawWeights = surviving.map(b => ({
      name: b.name,
      bps: Math.floor((b.score / totalScore) * 10_000),
    }))

    const allocatedSum = rawWeights.reduce((sum, w) => sum + w.bps, 0)
    const remainder = 10_000 - allocatedSum

    // Add remainder to the highest-scoring backend (first after sort)
    if (remainder > 0 && rawWeights.length > 0) {
      // Find highest-score backend among survivors
      const highestIdx = surviving.reduce(
        (maxIdx, b, i) => (b.score > surviving[maxIdx]!.score ? i : maxIdx),
        0
      )
      rawWeights[highestIdx]!.bps += remainder
    }

    const weights: Record<string, number> = {}
    rawWeights.forEach(w => { weights[w.name] = w.bps })

    return { weights, excludedBackends: excluded, scores }
  }
}
