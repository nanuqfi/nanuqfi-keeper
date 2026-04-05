export {
  computeRiskAdjustedScore,
  rankYieldSources,
  type YieldSource,
  type RankedSource,
} from './scoring.js'

export {
  checkAutoExit,
  type AutoExitResult,
  type AutoExitContext,
} from './auto-exit.js'

export {
  AlgorithmEngine,
  type BackendConfig,
  type VaultState,
  type WeightProposal,
  type ProposalContext,
} from './algorithm-engine.js'
