import { computeRiskAdjustedScore, type YieldSource } from './scoring.js'
import { checkAutoExit, type AutoExitContext } from './auto-exit.js'
import type { AIInsight } from '../ai/index.js'
import type { MarketScan } from '../scanner/index.js'

const PERP_STRATEGIES = new Set<string>()

// SOL-exposed strategies affected by oracle divergence
const SOL_EXPOSED = new Set<string>()

// Backend → risk tier mapping for market scan comparison
const BACKEND_RISK_TIER: Record<string, 'low' | 'medium' | 'high'> = {
  'kamino-lending': 'low',
  'marginfi-lending': 'low',
  'lulo-lending': 'low',
}

// Max perp allocation per risk level (basis points)
const PERP_CAP_BPS: Record<string, number> = {
  conservative: 3000,
  moderate: 6000,
  aggressive: 7000,
}

const LENDING_BACKEND = 'kamino-lending'

export interface ProposalContext {
  marketScan?: MarketScan
  oracleDeviation?: Record<string, number>
}

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
 *  2. Score the surviving backends (with AI, market scan, oracle, and slope modifiers).
 *  3. Allocate proportionally to risk-adjusted score, rounding to whole bps.
 *  4. Enforce perp concentration cap — redistribute overflow to lending.
 *     Any rounding remainder is added to the highest-scoring backend.
 */
export class AlgorithmEngine {
  propose(state: VaultState, aiInsight?: AIInsight, ctx?: ProposalContext): WeightProposal {
    const excluded: string[] = []
    const scores: Record<string, number> = {}

    // Step 1 — auto-exit check + scoring for all backends
    const surviving: Array<BackendConfig & { score: number }> = []

    for (const backend of state.backends) {
      const exitResult = checkAutoExit(backend.name, {
        ...backend.autoExitContext,
        riskLevel: backend.autoExitContext.riskLevel ?? state.riskLevel,
      })

      const rawScore = computeRiskAdjustedScore(backend.apy, backend.volatility)

      let score = rawScore

      // AI confidence multiplier
      if (aiInsight) {
        const confidence = aiInsight.strategies[backend.name] ?? 1.0
        score *= confidence
        if (aiInsight.riskElevated && PERP_STRATEGIES.has(backend.name)) {
          score *= 0.5
        }
        // Regime multipliers
        if (aiInsight.regime) {
          score *= getRegimeMultiplier(backend.name, aiInsight.regime)
        }
      }

      // Market scan opportunity cost penalty (Phase 1A)
      if (ctx?.marketScan) {
        score *= computeOpportunityCostMultiplier(backend, ctx.marketScan)
      }

      // Oracle divergence dampening (Phase 2A)
      if (ctx?.oracleDeviation && SOL_EXPOSED.has(backend.name)) {
        const solDev = ctx.oracleDeviation['SOL'] ?? 0
        if (solDev > 0.03) {
          score *= 0.1
        } else if (solDev > 0.01) {
          score *= 0.5
        }
      }

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
    const weights = this.allocateWeights(surviving)

    // Step 4 — enforce perp concentration cap (Phase 1B)
    this.enforcePerCap(weights, state.riskLevel, surviving)

    return { weights, excludedBackends: excluded, scores }
  }

  private allocateWeights(surviving: Array<{ name: string; score: number }>): Record<string, number> {
    const totalScore = surviving.reduce((sum, b) => sum + b.score, 0)

    if (totalScore === 0) {
      const equalShare = Math.floor(10_000 / surviving.length)
      const remainder = 10_000 - equalShare * surviving.length
      const weights: Record<string, number> = {}
      surviving.forEach((b, i) => {
        weights[b.name] = equalShare + (i === 0 ? remainder : 0)
      })
      return weights
    }

    const rawWeights = surviving.map(b => ({
      name: b.name,
      bps: Math.floor((b.score / totalScore) * 10_000),
    }))

    const allocatedSum = rawWeights.reduce((sum, w) => sum + w.bps, 0)
    const remainder = 10_000 - allocatedSum

    if (remainder > 0 && rawWeights.length > 0) {
      const highestIdx = surviving.reduce(
        (maxIdx, b, i) => (b.score > surviving[maxIdx]!.score ? i : maxIdx),
        0
      )
      rawWeights[highestIdx]!.bps += remainder
    }

    const weights: Record<string, number> = {}
    rawWeights.forEach(w => { weights[w.name] = w.bps })
    return weights
  }

  private enforcePerCap(
    weights: Record<string, number>,
    riskLevel: string,
    surviving: Array<{ name: string; score: number }>,
  ): void {
    const cap = PERP_CAP_BPS[riskLevel] ?? PERP_CAP_BPS['moderate']!
    const perpNames = surviving.filter(b => PERP_STRATEGIES.has(b.name)).map(b => b.name)
    const lendingPresent = LENDING_BACKEND in weights

    if (perpNames.length === 0 || !lendingPresent) return

    const perpTotal = perpNames.reduce((sum, n) => sum + (weights[n] ?? 0), 0)
    if (perpTotal <= cap) return

    // Scale perp strategies proportionally to fit cap
    const scaleFactor = cap / perpTotal
    let overflow = 0

    for (const name of perpNames) {
      const original = weights[name] ?? 0
      const scaled = Math.floor(original * scaleFactor)
      overflow += original - scaled
      weights[name] = scaled
    }

    // Redistribute overflow to lending
    weights[LENDING_BACKEND] = (weights[LENDING_BACKEND] ?? 0) + overflow

    // Fix rounding: ensure sum is exactly 10 000
    const total = Object.values(weights).reduce((s, v) => s + v, 0)
    if (total !== 10_000) {
      weights[LENDING_BACKEND] += 10_000 - total
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring modifiers
// ---------------------------------------------------------------------------

/** Phase 1A: opportunity cost penalty when better yields exist elsewhere */
function computeOpportunityCostMultiplier(backend: BackendConfig, scan: MarketScan): number {
  const tier = BACKEND_RISK_TIER[backend.name]
  if (!tier) return 1.0

  const bestExternal = scan.bestByRisk[tier]
  if (!bestExternal) return 1.0

  const ratio = bestExternal.apy / Math.max(backend.apy, 0.0001)
  if (ratio > 2) return 0.7
  return 1.0
}

/** Phase 1C: regime-based multiplier per strategy */
function getRegimeMultiplier(backendName: string, regime: 'trend' | 'range' | 'stress'): number {
  const REGIME_MULTIPLIERS: Record<string, Record<string, number>> = {
    trend: { 'kamino-lending': 1.0, 'marginfi-lending': 1.0, 'lulo-lending': 1.0 },
    range: { 'kamino-lending': 1.2, 'marginfi-lending': 1.2, 'lulo-lending': 1.2 },
    stress: { 'kamino-lending': 1.5, 'marginfi-lending': 1.5, 'lulo-lending': 1.5 },
  }
  return REGIME_MULTIPLIERS[regime]?.[backendName] ?? 1.0
}

