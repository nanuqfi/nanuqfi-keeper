import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { KeeperConfig } from './config.js'
import { HealthMonitor } from './health/monitor.js'
import { AlgorithmEngine, type BackendConfig, type VaultState, type WeightProposal, type ProposalContext } from './engine/index.js'
import { scanDeFiYields, type MarketScan } from './scanner/index.js'
import { createAlerter, type Alerter } from './alerts/index.js'
import { submitRebalance, type RebalanceResult } from './chain/index.js'
import { fetchRebalanceChainState } from './chain/state.js'
import { AIProvider, buildInsightPrompt, validateAIInsight, type AIInsight, type MarketContext } from './ai/index.js'
import { runBacktest, fetchHistoricalData, DEFAULT_CONFIG } from './backtest/index.js'
import type { BacktestResult } from './backtest/index.js'

const AI_HISTORY_PATH = process.env.AI_HISTORY_PATH ?? '/data/ai-history.json'
const AI_HISTORY_MAX = 500
const DECISION_HISTORY_PATH = process.env.DECISION_HISTORY_PATH ?? '/data/decision-history.json'

export interface YieldData {
  kaminoSupplyRate: number
  marginfiLendingRate: number
  luloRegularRate: number
}

export interface KeeperDecision {
  timestamp: number
  riskLevel: string
  proposal: WeightProposal
  yieldData: YieldData
  aiInsight?: AIInsight
  txSignature?: string
  txStatus?: 'pending' | 'confirmed' | 'failed'
}

export interface KeeperDeps {
  config: KeeperConfig
  monitor: HealthMonitor
  ai?: AIProvider
}

export class Keeper {
  private readonly config: KeeperConfig
  private readonly monitor: HealthMonitor
  private readonly engine: AlgorithmEngine
  private readonly alerter: Alerter
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
  private backtestCache: BacktestResult | null = null
  private backtestCacheTime = 0

  constructor(deps: KeeperDeps) {
    this.config = deps.config
    this.monitor = deps.monitor
    this.ai = deps.ai ?? null
    this.engine = new AlgorithmEngine()
    this.alerter = createAlerter(deps.config)
  }

  async boot(): Promise<void> {
    this.loadAIHistory()
    this.loadDecisionHistory()
    this.restoreCurrentWeights()

    // Verify RPC connectivity
    await this.checkRpc()
  }

  private restoreCurrentWeights(): void {
    // Rebuild currentWeights from the most recent decision per vault
    // so the first cycle has proper "previous weights" context.
    // Skip 'pending' and 'failed' decisions — pending means the tx outcome is
    // unknown (crash during submission), failed means the on-chain state never
    // changed. Restoring either would give the keeper wrong "previous weights".
    // Decisions without txStatus are pre-fix legacy entries — treat as confirmed
    // for backward compatibility.
    for (const riskLevel of ['moderate', 'aggressive']) {
      const latest = [...this.decisions]
        .reverse()
        .find(d => {
          if (d.riskLevel !== riskLevel) return false
          if (d.txStatus === 'failed' || d.txStatus === 'pending') return false
          return true
        })
      if (latest?.proposal?.weights) {
        this.currentWeights[riskLevel] = latest.proposal.weights
      }
    }
    const restored = Object.keys(this.currentWeights).length
    if (restored > 0) {
      console.log(`[Keeper] Restored weights for ${restored} vault(s) from decision history`)
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

  /** Fetch historical simulation results, cached for 1 hour. */
  async getBacktestResult(): Promise<BacktestResult | null> {
    const CACHE_TTL = 3_600_000 // 1 hour
    if (this.backtestCache && Date.now() - this.backtestCacheTime < CACHE_TTL) {
      return this.backtestCache
    }
    try {
      const data = await fetchHistoricalData(DEFAULT_CONFIG)
      this.backtestCache = runBacktest(data, DEFAULT_CONFIG)
      this.backtestCacheTime = Date.now()
      return this.backtestCache
    } catch {
      // Return stale cache on error rather than failing hard
      return this.backtestCache
    }
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

  private loadDecisionHistory(): void {
    try {
      const raw = readFileSync(DECISION_HISTORY_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.decisions = parsed.slice(-this.maxDecisionHistory)
        console.log(`[Keeper] Loaded ${this.decisions.length} decisions from disk`)
      }
    } catch {
      this.decisions = []
    }
  }

  private saveDecisionHistory(): void {
    try {
      const dir = DECISION_HISTORY_PATH.substring(0, DECISION_HISTORY_PATH.lastIndexOf('/'))
      if (dir) mkdirSync(dir, { recursive: true })
      writeFileSync(DECISION_HISTORY_PATH, JSON.stringify(this.decisions))
    } catch (err) {
      console.error('[Keeper] Failed to persist decisions:', err instanceof Error ? err.message : err)
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
        fundingRates: {},
        lendingApy: yieldData.kaminoSupplyRate,
        insuranceYield: 0,
        recentLiquidationVolume: 0,
        oracleDeviation: {},
      }

      const strategyNames = ['kamino-lending', 'marginfi-lending', 'lulo-lending']
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
      // 1. Fetch real yield data
      const yieldData = await this.fetchYieldData()
      this.latestYieldData = yieldData

      // 2. Scan DeFi yields BEFORE proposing — feeds opportunity cost into scoring
      const marketScan = await scanDeFiYields()
      this.latestMarketScan = marketScan

      // 3. Build proposal context with market scan + oracle data
      const proposalCtx: ProposalContext = {
        marketScan,
        oracleDeviation: this.cachedInsight ? {} : undefined,
      }

      // 4. Run algorithm engine for each vault (moderate + aggressive)
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

        // Cap decision history to prevent unbounded memory growth
        if (this.decisions.length > this.maxDecisionHistory) {
          this.decisions = this.decisions.slice(-this.maxDecisionHistory)
        }

        // Submit rebalance tx to on-chain allocator (if keypair configured).
        // Weights are only updated on confirmed tx — never optimistically.
        if (this.config.keeperKeypairPath && this.config.rpcUrls[0]) {
          const reasoning = this.getAIInsight()?.reasoning ?? 'Algorithm-only rebalance'
          const decision = this.decisions[this.decisions.length - 1]

          // Mark 'pending' before await so the disk state is accurate if the
          // process crashes mid-submission — 'pending' signals unknown outcome.
          if (decision) decision.txStatus = 'pending'

          try {
            // Fetch real on-chain state: per-vault counter (PDA seed), USDC
            // addresses, and current equity. Must happen before submitRebalance
            // so the instruction lands with correct account keys.
            const chainState = await fetchRebalanceChainState(this.config.rpcUrls[0], riskLevel)

            const result = await submitRebalance({
              rpcUrl: this.config.rpcUrls[0],
              keypairPath: this.config.keeperKeypairPath,
              riskLevel,
              weights: proposal.weights,
              reasoning,
              rebalanceCounter: chainState.rebalanceCounter,
              equitySnapshot: chainState.equitySnapshot,
              vaultUsdcAddress: chainState.vaultUsdcAddress,
              treasuryUsdcAddress: chainState.treasuryUsdcAddress,
            })

            if (result.success) {
              if (decision) {
                decision.txSignature = result.txSignature
                decision.txStatus = 'confirmed'
              }
              this.currentWeights[riskLevel] = proposal.weights
              console.log(`[Chain] Rebalance tx confirmed: ${result.txSignature}`)
            } else {
              if (decision) decision.txStatus = 'failed'
              console.error(`[Chain] Rebalance tx failed for ${riskLevel}: ${result.error}`)
              await this.alerter.alert(`❌ On-chain rebalance failed for ${riskLevel}: ${result.error}`)
            }
          } catch (err) {
            if (decision) decision.txStatus = 'failed'
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[Chain] Rebalance submission error for ${riskLevel}: ${msg}`)
            await this.alerter.alert(`❌ On-chain rebalance error for ${riskLevel}: ${msg}`)
          }
        } else {
          // Algorithm-only mode — no on-chain tx, update weights directly
          this.currentWeights[riskLevel] = proposal.weights
        }

        // Persist after tx result is known so txStatus ('pending'/'confirmed'/'failed')
        // is accurately written to disk. The early-save race is intentional here:
        // we save once per vault after its full tx lifecycle completes.
        this.saveDecisionHistory()
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
    let kaminoRate = 0.021 // fallback
    try {
      const res = await fetch(
        'https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics'
      )
      if (res.ok) {
        const data = await res.json() as { liquidityToken: string; supplyApy: string }[]
        const usdc = data.find(r => r.liquidityToken === 'USDC')
        if (usdc) kaminoRate = Number(usdc.supplyApy)
      }
    } catch {
      // Use fallback rate
    }

    let luloRate = 0.07 // fallback
    try {
      const luloApiKey = process.env.LULO_API_KEY
      if (luloApiKey) {
        const luloRes = await fetch(
          'https://api.lulo.fi/v1/rates.getRates',
          { headers: { 'x-api-key': luloApiKey, 'Content-Type': 'application/json' } }
        )
        if (luloRes.ok) {
          const luloData = await luloRes.json() as { regular?: { CURRENT?: number } }
          if (luloData.regular?.CURRENT) {
            luloRate = luloData.regular.CURRENT / 100 // percentage → decimal
          }
        }
      }
    } catch {
      // Use fallback rate
    }

    return {
      kaminoSupplyRate: kaminoRate,
      marginfiLendingRate: 0.065, // Mock — Marginfi SDK has broken IDL
      luloRegularRate: luloRate,
    }
  }

  private buildBackendConfigs(data: YieldData, _riskLevel: string): BackendConfig[] {
    return [
      {
        name: 'kamino-lending',
        apy: data.kaminoSupplyRate,
        volatility: 0.03,
        autoExitContext: { riskLevel: _riskLevel },
      },
      {
        name: 'marginfi-lending',
        apy: data.marginfiLendingRate,
        volatility: 0.04,
        autoExitContext: { riskLevel: _riskLevel },
      },
      {
        name: 'lulo-lending',
        apy: data.luloRegularRate,
        volatility: 0.02,
        autoExitContext: { riskLevel: _riskLevel },
      },
    ]
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
