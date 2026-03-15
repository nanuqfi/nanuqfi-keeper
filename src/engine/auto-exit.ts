export interface AutoExitResult {
  shouldExit: boolean
  reason?: string
}

export interface AutoExitContext {
  /** Funding rate history entries (newest-last). Used by drift-basis. */
  fundingHistory?: number[]
  /** Unrealised PnL as a decimal fraction (e.g. -0.03 = -3%). Used by drift-funding. */
  unrealizedPnlPercent?: number
  /** Vault risk level: 'conservative' | 'moderate' | 'aggressive'. Used by drift-funding. */
  riskLevel?: string
  /** Insurance fund drawdown as a decimal fraction (e.g. 0.35 = 35%). Used by drift-insurance. */
  insuranceFundDrawdown?: number
  /** SOL borrow rate as an annualised decimal. Used by drift-jito-dn. */
  solBorrowRate?: number
  /** JitoSOL staking yield as an annualised decimal. Used by drift-jito-dn. */
  jitoStakingYield?: number
}

// Minimum consecutive negative funding periods before a basis-trade exit is triggered.
// 16 × 15-min intervals = 4 hours of sustained negative funding.
const BASIS_NEGATIVE_WINDOW = 16

// Unrealised PnL thresholds per risk profile.
const FUNDING_PNL_THRESHOLD: Record<string, number> = {
  conservative: -0.02,
  moderate: -0.02,
  aggressive: -0.05,
}

const INSURANCE_DRAWDOWN_THRESHOLD = 0.30

/**
 * Evaluate whether a backend should auto-exit given the current market context.
 *
 * Returns `shouldExit: false` for any unknown backend so that missing
 * configuration never accidentally triggers a position closure.
 */
export function checkAutoExit(backend: string, ctx: AutoExitContext): AutoExitResult {
  switch (backend) {
    case 'drift-basis':
      return checkBasisExit(ctx)

    case 'drift-funding':
      return checkFundingExit(ctx)

    case 'drift-insurance':
      return checkInsuranceExit(ctx)

    case 'drift-jito-dn':
      return checkJitoDnExit(ctx)

    default:
      return { shouldExit: false }
  }
}

// ---------------------------------------------------------------------------
// Per-strategy helpers
// ---------------------------------------------------------------------------

function checkBasisExit(ctx: AutoExitContext): AutoExitResult {
  const history = ctx.fundingHistory
  if (!history || history.length < BASIS_NEGATIVE_WINDOW) {
    return { shouldExit: false }
  }

  // Examine only the most recent window entries
  const window = history.slice(-BASIS_NEGATIVE_WINDOW)
  const allNegative = window.every(rate => rate < 0)

  if (allNegative) {
    return {
      shouldExit: true,
      reason: `Funding negative for last ${BASIS_NEGATIVE_WINDOW} consecutive periods (~4h)`,
    }
  }

  return { shouldExit: false }
}

function checkFundingExit(ctx: AutoExitContext): AutoExitResult {
  const pnl = ctx.unrealizedPnlPercent
  if (pnl === undefined || pnl === null) {
    return { shouldExit: false }
  }

  // Default to 'moderate' threshold when risk level is absent or unrecognised.
  const riskKey = ctx.riskLevel?.toLowerCase() ?? 'moderate'
  const threshold = FUNDING_PNL_THRESHOLD[riskKey] ?? FUNDING_PNL_THRESHOLD['moderate']!

  if (pnl <= threshold) {
    return {
      shouldExit: true,
      reason: `Unrealised PnL ${(pnl * 100).toFixed(2)}% breached ${(threshold * 100).toFixed(2)}% threshold for ${riskKey} risk`,
    }
  }

  return { shouldExit: false }
}

function checkInsuranceExit(ctx: AutoExitContext): AutoExitResult {
  const drawdown = ctx.insuranceFundDrawdown
  if (drawdown === undefined || drawdown === null) {
    return { shouldExit: false }
  }

  if (drawdown >= INSURANCE_DRAWDOWN_THRESHOLD) {
    return {
      shouldExit: true,
      reason: `Insurance fund drawdown ${(drawdown * 100).toFixed(1)}% reached ${INSURANCE_DRAWDOWN_THRESHOLD * 100}% threshold`,
    }
  }

  return { shouldExit: false }
}

function checkJitoDnExit(ctx: AutoExitContext): AutoExitResult {
  const { solBorrowRate, jitoStakingYield } = ctx

  if (solBorrowRate === undefined || solBorrowRate === null) {
    return { shouldExit: false }
  }
  if (jitoStakingYield === undefined || jitoStakingYield === null) {
    return { shouldExit: false }
  }

  if (solBorrowRate >= jitoStakingYield) {
    return {
      shouldExit: true,
      reason: `SOL borrow rate (${(solBorrowRate * 100).toFixed(2)}%) ≥ JitoSOL yield (${(jitoStakingYield * 100).toFixed(2)}%) — carry trade inverted`,
    }
  }

  return { shouldExit: false }
}
