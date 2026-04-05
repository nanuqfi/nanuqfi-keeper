import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { KeeperConfig } from './config.js'
import { HealthMonitor } from './health/monitor.js'
import { initDriftClient, checkDriftHealth, DriftDataCache } from './drift/index.js'
import { AlgorithmEngine, type BackendConfig, type VaultState, type WeightProposal, type ProposalContext } from './engine/index.js'
import { scanDeFiYields, type MarketScan } from './scanner/index.js'
import { createAlerter, type Alerter } from './alerts/index.js'
import { submitRebalance, riskLevelToIndex, type RebalanceResult } from './chain/index.js'
import type { DriftClient } from '@drift-labs/sdk'
import { AIProvider, buildInsightPrompt, validateAIInsight, type AIInsight, type MarketContext } from './ai/index.js'

const AI_HISTORY_PATH = process.env.AI_HISTORY_PATH ?? '/data/ai-history.json'
const AI_HISTORY_MAX = 500

export interface YieldData {
  usdcLendingRate: number
  solFundingRate: number
  solFundingHistory: number[]
  solBorrowRate: number
  jitoStakingYield: number
}

export interface KeeperDecision {
  timestamp: number
  riskLevel: string
  proposal: WeightProposal
  yieldData: YieldData
  aiInsight?: AIInsight
  txSignature?: string
}

export interface KeeperDeps {
  config: KeeperConfig
  monitor: HealthMonitor
  driftClient?: DriftClient
  dataCache?: DriftDataCache
  ai?: AIProvider
}

export class Keeper {
  private readonly config: KeeperConfig
  private readonly monitor: HealthMonitor
  private readonly engine: AlgorithmEngine
  private readonly alerter: Alerter
  private driftClient?: DriftClient
  private dataCache?: DriftDataCache
  private ai: AIProvider | null
  private running = false
  private cycleTimer: ReturnType<typeof setTimeout> | null = null
  private aiCycleTimer: ReturnType<typeof setTimeout> | null = null
  private currentWeights: Record<string, Record<string, number>> = {}
  private readonly maxDecisionHistory = 500
  private decisions: KeeperDecision[] = []
  private latestMarketScan: MarketScan | null = null
  private latestYieldData: YieldData | null = null
  private cachedInsight: AIInsight | null = null
  private aiHistory: AIInsight[] = []

  constructor(deps: KeeperDeps) {
    this.config = deps.config
    this.monitor = deps.monitor
    this.driftClient = deps.driftClient
    this.dataCache = deps.dataCache
    this.ai = deps.ai ?? null
    this.engine = new AlgorithmEngine()
    this.alerter = createAlerter(deps.config)
  }

  async boot(): Promise<void> {
    this.loadAIHistory()

    // 1. Verify RPC connectivity
    await this.checkRpc()

    // 2. Initialize Drift SDK if config present and not already injected
    if (this.config.drift?.rpcUrl && !this.driftClient) {
      this.driftClient = await initDriftClient(this.config.drift)
      this.dataCache = new DriftDataCache()
    }
  }

  async start(): Promise<void> {
    this.running = true
    await this.boot()
    await this.runCycle()
    await this.runAICycle()
    this.scheduleNextCycle()
    this.scheduleNextAICycle()
  }

  stop(): void {
    this.running = false
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer)
      this.cycleTimer = null
    }
    if (this.aiCycleTimer) {
      clearTimeout(this.aiCycleTimer)
      this.aiCycleTimer = null
    }
  }

  /** Access latest decisions for API consumers. */
  getDecisions(): KeeperDecision[] {
    return this.decisions
  }

  /** Access latest market scan for API consumers. */
  getMarketScan(): MarketScan | null {
    return this.latestMarketScan
  }

  /** Access latest yield data for API consumers. */
  getYieldData(): YieldData | null {
    return this.latestYieldData
  }

  /** Access current weight allocations per risk level. */
  getCurrentWeights(): Record<string, Record<string, number>> {
    return this.currentWeights
  }

  /** Access cached AI insight, returns null if absent or stale. */
  getAIInsight(): AIInsight | null {
    if (!this.cachedInsight) return null
    const maxAge = this.config.aiCycleIntervalMs * 2
    if (Date.now() - this.cachedInsight.timestamp > maxAge) {
      this.cachedInsight = null
      return null
    }
    return this.cachedInsight
  }

  /** Access AI insight history, most recent first. */
  getAIHistory(limit = 20): AIInsight[] {
    return this.aiHistory.slice(-limit).reverse()
  }

  private loadAIHistory(): void {
    try {
      const raw = readFileSync(AI_HISTORY_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.aiHistory = parsed.slice(-AI_HISTORY_MAX)
      }
    } catch {
      this.aiHistory = []
    }
  }

  private saveAIHistory(): void {
    try {
      const dir = AI_HISTORY_PATH.substring(0, AI_HISTORY_PATH.lastIndexOf('/'))
      if (dir) mkdirSync(dir, { recursive: true })
      writeFileSync(AI_HISTORY_PATH, JSON.stringify(this.aiHistory))
    } catch (err) {
      console.error('[AI] Failed to persist history:', err instanceof Error ? err.message : err)
    }
  }

  private scheduleNextCycle(): void {
    if (!this.running) return
    this.cycleTimer = setTimeout(async () => {
      await this.runCycle()
      this.scheduleNextCycle()
    }, this.config.cycleIntervalMs)
  }

  private scheduleNextAICycle(): void {
    if (!this.running || !this.ai) return
    this.aiCycleTimer = setTimeout(async () => {
      await this.runAICycle()
      this.scheduleNextAICycle()
    }, this.config.aiCycleIntervalMs)
  }

  async runAICycle(): Promise<void> {
    if (!this.ai) return
    if (!this.ai.isAvailable) {
      console.log('[AI] Skipped — provider unavailable (rate limited or circuit open)')
      return
    }

    try {
      const yieldData = this.latestYieldData ?? await this.fetchYieldData()
      const weights = this.currentWeights

      const context: MarketContext = {
        vaultTvl: { moderate: 0, aggressive: 0 },
        currentPositions: Object.entries(weights['moderate'] ?? {}).map(([name, bps]) => ({
          name,
          allocation: bps / 100,
        })),
        fundingRates: { 'SOL-PERP': yieldData.solFundingRate },
        lendingApy: yieldData.usdcLendingRate,
        insuranceYield: 0,
        recentLiquidationVolume: 0,
        oracleDeviation: {},
      }

      const strategyNames = ['drift-lending', 'drift-basis', 'drift-funding', 'drift-jito-dn']
      const prompt = buildInsightPrompt(context, strategyNames)
      const rawResponse = await this.ai.analyze(prompt)
      const result = validateAIInsight(rawResponse)

      if (result.valid && result.insight) {
        this.cachedInsight = { ...result.insight, timestamp: Date.now() }
        console.log(`[AI] Insight cached — risk_elevated: ${result.insight.riskElevated}, regime: ${result.insight.regime ?? 'none'}, reasoning: ${result.insight.reasoning}`)
        this.aiHistory.push(this.cachedInsight)
        if (this.aiHistory.length > AI_HISTORY_MAX) {
          this.aiHistory = this.aiHistory.slice(-AI_HISTORY_MAX)
        }
        this.saveAIHistory()

        // Alert on stress regime
        if (result.insight.regime === 'stress') {
          this.alerter.alert(`⚠️ STRESS REGIME detected\n${result.insight.reasoning}`).catch(() => {})
        }
      } else {
        console.warn(`[AI] Invalid response rejected: ${result.rejectionReason}`)
      }
    } catch (error) {
      console.error('[AI] Cycle failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  async runCycle(): Promise<void> {
    const cycleTimeout = 60_000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), cycleTimeout)

    try {
      // 1. Check Drift subscription health
      if (this.driftClient && !checkDriftHealth(this.driftClient)) {
        this.monitor.recordCycleFailure('Drift subscription unhealthy')
        return
      }

      // 2. Fetch real yield data (or use defaults if no Drift connection)
      const yieldData = await this.fetchYieldData()
      this.latestYieldData = yieldData

      // 3. Scan DeFi yields BEFORE proposing — feeds opportunity cost into scoring
      const marketScan = await scanDeFiYields()
      this.latestMarketScan = marketScan

      // 4. Build proposal context with market scan + oracle data
      const proposalCtx: ProposalContext = {
        marketScan,
        oracleDeviation: this.cachedInsight ? {} : undefined,
      }

      // 5. Run algorithm engine for each vault (moderate + aggressive)
      const vaults = ['moderate', 'aggressive'] as const
      for (const riskLevel of vaults) {
        const backends = this.buildBackendConfigs(yieldData, riskLevel)
        const state: VaultState = {
          riskLevel,
          backends,
          currentWeights: this.currentWeights[riskLevel] ?? {},
        }

        const proposal = this.engine.propose(state, this.getAIInsight() ?? undefined, proposalCtx)

        // Log the decision
        this.decisions.push({
          timestamp: Date.now(),
          riskLevel,
          proposal,
          yieldData,
          aiInsight: this.getAIInsight() ?? undefined,
        })

        // Update current weights
        this.currentWeights[riskLevel] = proposal.weights

        // Cap decision history to prevent unbounded memory growth
        if (this.decisions.length > this.maxDecisionHistory) {
          this.decisions = this.decisions.slice(-this.maxDecisionHistory)
        }

        // Submit rebalance tx to on-chain allocator (if keypair configured)
        if (this.config.keeperKeypairPath && this.config.rpcUrls[0]) {
          const reasoning = this.getAIInsight()?.reasoning ?? 'Algorithm-only rebalance'
          submitRebalance({
            rpcUrl: this.config.rpcUrls[0],
            keypairPath: this.config.keeperKeypairPath,
            riskLevel,
            weights: proposal.weights,
            reasoning,
            rebalanceCounter: this.decisions.length,
            equitySnapshot: 0n,
            vaultUsdcAddress: new (await import('@solana/web3.js')).PublicKey('11111111111111111111111111111111'),
            treasuryUsdcAddress: new (await import('@solana/web3.js')).PublicKey('11111111111111111111111111111111'),
          }).then(result => {
            if (result.success) {
              console.log(`[Chain] Rebalance tx submitted: ${result.txSignature}`)
              // Store tx in the latest decision
              const lastDecision = this.decisions[this.decisions.length - 1]
              if (lastDecision) lastDecision.txSignature = result.txSignature
            } else {
              console.warn(`[Chain] Rebalance tx failed: ${result.error}`)
              this.alerter.alert(`❌ On-chain rebalance failed: ${result.error}`).catch(() => {})
            }
          }).catch(err => {
            console.warn(`[Chain] Rebalance submission error: ${err instanceof Error ? err.message : err}`)
          })
        }
      }

      // 5. Record success
      this.monitor.recordCycleSuccess()

    } catch (error) {
      if (controller.signal.aborted) {
        this.monitor.recordCycleFailure('Cycle timeout (60s)')
        this.alerter.alert('⏱️ Keeper cycle timed out (60s)').catch(() => {})
      } else {
        const msg = error instanceof Error ? error.message : 'Unknown error'
        this.monitor.recordCycleFailure(msg)
        this.alerter.alert(`❌ Keeper cycle failed: ${msg}`).catch(() => {})
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async fetchYieldData(): Promise<YieldData> {
    if (!this.dataCache) {
      // No Drift connection — return conservative defaults
      return {
        usdcLendingRate: 0.02,
        solFundingRate: 0,
        solFundingHistory: [],
        solBorrowRate: 0.05,
        jitoStakingYield: 0.07,
      }
    }

    const [depositRate, fundingRates, borrowRate] = await Promise.all([
      this.dataCache.getDepositRate(0).catch(() => 0.02),
      this.dataCache.getFundingRates('SOL-PERP').catch(() => []),
      this.dataCache.getBorrowRate(1).catch(() => 0.05),
    ])

    const latestFunding = fundingRates.length > 0
      ? fundingRates[fundingRates.length - 1]!.annualizedApr / 100
      : 0

    const fundingHistory = fundingRates.map(r => r.hourlyRate)

    return {
      usdcLendingRate: depositRate,
      solFundingRate: latestFunding,
      solFundingHistory: fundingHistory,
      solBorrowRate: borrowRate,
      jitoStakingYield: 0.07, // Approximate — Jito API integration later
    }
  }

  private buildBackendConfigs(data: YieldData, riskLevel: string): BackendConfig[] {
    const configs: BackendConfig[] = [
      {
        name: 'drift-lending',
        apy: data.usdcLendingRate,
        volatility: 0.05,
        autoExitContext: { riskLevel },
      },
      {
        name: 'drift-basis',
        apy: Math.abs(data.solFundingRate),
        volatility: 0.20,
        autoExitContext: {
          riskLevel,
          fundingHistory: data.solFundingHistory,
        },
      },
      {
        name: 'drift-jito-dn',
        apy: Math.max(data.jitoStakingYield - data.solBorrowRate, 0),
        volatility: 0.18,
        autoExitContext: {
          riskLevel,
          solBorrowRate: data.solBorrowRate,
          jitoStakingYield: data.jitoStakingYield,
        },
      },
    ]

    // Funding capture only for aggressive
    if (riskLevel === 'aggressive') {
      configs.push({
        name: 'drift-funding',
        apy: data.solFundingRate,
        volatility: 0.35,
        autoExitContext: {
          riskLevel,
          unrealizedPnlPercent: 0,
        },
      })
    }

    return configs
  }

  private async checkRpc(): Promise<void> {
    for (const url of this.config.rpcUrls) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5_000)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (res.ok) {
          this.monitor.setRpcStatus('healthy')
          return
        }
      } catch {
        // Try next RPC
      }
    }
    this.monitor.setRpcStatus('down')
    throw new Error('All RPC endpoints unreachable')
  }
}
