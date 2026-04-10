export interface AIWeightSuggestion {
  weights: Record<string, number>  // backend name → percentage (0-100, sum to 100)
  confidence: number               // 0-1
  reasoning: string
}

export interface ValidationResult {
  valid: boolean
  suggestion?: AIWeightSuggestion
  rejectionReason?: string
}

const WEIGHT_SUM_TOLERANCE = 0.5

export function validateAIResponse(raw: string): ValidationResult {
  // 1. Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, rejectionReason: 'Failed to parse response as JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, rejectionReason: 'Response must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>

  // 2. Required fields present
  if (!('weights' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: weights' }
  }
  if (!('confidence' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: confidence' }
  }
  if (!('reasoning' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: reasoning' }
  }

  // 3. Validate weights
  const weights = obj['weights']
  if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) {
    return { valid: false, rejectionReason: 'Field "weights" must be a non-null object' }
  }

  const weightMap = weights as Record<string, unknown>
  const weightEntries = Object.entries(weightMap)

  for (const [key, val] of weightEntries) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { valid: false, rejectionReason: `Weight "${key}" must be a finite number` }
    }
    if (val < 0) {
      return { valid: false, rejectionReason: `Weight "${key}" must be non-negative, got ${val}` }
    }
  }

  const weightSum = weightEntries.reduce((acc, [, v]) => acc + (v as number), 0)
  if (Math.abs(weightSum - 100) > WEIGHT_SUM_TOLERANCE) {
    return {
      valid: false,
      rejectionReason: `Weights sum to ${weightSum.toFixed(4)}, expected 100 (±${WEIGHT_SUM_TOLERANCE})`,
    }
  }

  // 4. Validate confidence
  const confidence = obj['confidence']
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return { valid: false, rejectionReason: 'Field "confidence" must be a finite number' }
  }
  if (confidence < 0 || confidence > 1) {
    return {
      valid: false,
      rejectionReason: `Field "confidence" must be between 0 and 1, got ${confidence}`,
    }
  }

  // 5. Validate reasoning
  const reasoning = obj['reasoning']
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) {
    return { valid: false, rejectionReason: 'Field "reasoning" must be a non-empty string' }
  }

  return {
    valid: true,
    suggestion: {
      weights: weightMap as Record<string, number>,
      confidence,
      reasoning,
    },
  }
}

// ─── AIInsight (confidence-based, replaces weight-based suggestion) ─────

export type MarketRegime = 'trend' | 'range' | 'stress'

export interface AIInsight {
  strategies: Record<string, number>  // per-strategy confidence 0.0–1.0
  riskElevated: boolean               // cross-cutting risk flag
  regime?: MarketRegime               // detected market regime
  reasoning: string                   // human-readable explanation
  timestamp: number                   // set by caller, not validated here
}

export interface InsightValidationResult {
  valid: boolean
  insight?: AIInsight
  rejectionReason?: string
}

/**
 * Canonical backend names — must match DEFAULT_BACKEND_ORDER in chain/rebalance.ts.
 * Any AI response referencing strategy names outside this set is rejected to
 * prevent the keeper from acting on hallucinated or mistyped backend names.
 */
export const KNOWN_BACKEND_NAMES = new Set([
  'kamino-lending',
  'marginfi-lending',
  'lulo-lending',
])

export function validateAIInsight(raw: string): InsightValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, rejectionReason: 'Failed to parse response as JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, rejectionReason: 'Response must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>

  // 1. strategies
  if (!('strategies' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: strategies' }
  }
  const strategies = obj['strategies']
  if (typeof strategies !== 'object' || strategies === null || Array.isArray(strategies)) {
    return { valid: false, rejectionReason: 'Field "strategies" must be a non-null object' }
  }

  const stratMap = strategies as Record<string, unknown>
  for (const [key, val] of Object.entries(stratMap)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { valid: false, rejectionReason: `Strategy "${key}" confidence must be a finite number` }
    }
    if (val < 0 || val > 1) {
      return { valid: false, rejectionReason: `Strategy "${key}" confidence must be 0.0–1.0, got ${val}` }
    }
    // Reject unknown backend names — prevents keeper from acting on hallucinated strategies
    if (!KNOWN_BACKEND_NAMES.has(key)) {
      return {
        valid: false,
        rejectionReason: `Strategy "${key}" is not a known backend — expected one of: ${[...KNOWN_BACKEND_NAMES].join(', ')}`,
      }
    }
  }

  // 2. risk_elevated
  if (!('risk_elevated' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: risk_elevated' }
  }
  if (typeof obj['risk_elevated'] !== 'boolean') {
    return { valid: false, rejectionReason: 'Field "risk_elevated" must be a boolean' }
  }

  // 3. regime (optional)
  const VALID_REGIMES = new Set(['trend', 'range', 'stress'])
  let regime: MarketRegime | undefined
  if ('regime' in obj) {
    if (typeof obj['regime'] !== 'string' || !VALID_REGIMES.has(obj['regime'])) {
      return { valid: false, rejectionReason: `Field "regime" must be one of: trend, range, stress` }
    }
    regime = obj['regime'] as MarketRegime
  }

  // 4. reasoning
  if (!('reasoning' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: reasoning' }
  }
  if (typeof obj['reasoning'] !== 'string' || (obj['reasoning'] as string).trim().length === 0) {
    return { valid: false, rejectionReason: 'Field "reasoning" must be a non-empty string' }
  }

  return {
    valid: true,
    insight: {
      strategies: stratMap as Record<string, number>,
      riskElevated: obj['risk_elevated'] as boolean,
      regime,
      reasoning: obj['reasoning'] as string,
      timestamp: 0, // caller sets this
    },
  }
}
