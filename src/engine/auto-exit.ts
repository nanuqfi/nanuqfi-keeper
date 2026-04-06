export interface AutoExitResult {
  shouldExit: boolean
  reason?: string
}

export interface AutoExitContext {
  /** Vault risk level: 'conservative' | 'moderate' | 'aggressive'. */
  riskLevel?: string
}

/**
 * Evaluate whether a backend should auto-exit given the current market context.
 *
 * Currently no lending backends (kamino, marginfi, lulo) have automatic exit
 * triggers — exits are proposal-based via the algorithm engine.
 *
 * Returns `shouldExit: false` for any backend so that missing configuration
 * never accidentally triggers a position closure.
 */
export function checkAutoExit(_backend: string, _ctx: AutoExitContext): AutoExitResult {
  return { shouldExit: false }
}
