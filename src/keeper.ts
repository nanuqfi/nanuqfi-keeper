import type { KeeperConfig } from './config.js'
import { HealthMonitor } from './health/monitor.js'
import { initDriftClient, checkDriftHealth, DriftDataCache } from './drift/index.js'
import { AlgorithmEngine, type BackendConfig, type VaultState, type WeightProposal } from './engine/index.js'
import { scanDeFiYields, type MarketScan } from './scanner/index.js'
import type { DriftClient } from '@drift-labs/sdk'

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
}

export interface KeeperDeps {
  config: KeeperConfig
  monitor: HealthMonitor
  driftClient?: DriftClient
  dataCache?: DriftDataCache
}

export class Keeper {
  private readonly config: KeeperConfig
  private readonly monitor: HealthMonitor
  private readonly engine: AlgorithmEngine
  private driftClient?: DriftClient
  private dataCache?: DriftDataCache
  private running = false
  private cycleTimer: ReturnType<typeof setTimeout> | null = null
  private currentWeights: Record<string, Record<string, number>> = {}
  private readonly maxDecisionHistory = 500
  private decisions: KeeperDecision[] = []
  private latestMarketScan: MarketScan | null = null
  private latestYieldData: YieldData | null = null

  constructor(deps: KeeperDeps) {
    this.config = deps.config
    this.monitor = deps.monitor
    this.driftClient = deps.driftClient
    this.dataCache = deps.dataCache
    this.engine = new AlgorithmEngine()
  }

  async boot(): Promise<void> {
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
    this.scheduleNextCycle()
  }

  stop(): void {
    this.running = false
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer)
      this.cycleTimer = null
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

  private scheduleNextCycle(): void {
    if (!this.running) return
    this.cycleTimer = setTimeout(async () => {
      await this.runCycle()
      this.scheduleNextCycle()
    }, this.config.cycleIntervalMs)
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

      // 3. Run algorithm engine for each vault (moderate + aggressive)
      const vaults = ['moderate', 'aggressive'] as const
      for (const riskLevel of vaults) {
        const backends = this.buildBackendConfigs(yieldData, riskLevel)
        const state: VaultState = {
          riskLevel,
          backends,
          currentWeights: this.currentWeights[riskLevel] ?? {},
        }

        const proposal = this.engine.propose(state)

        // Log the decision
        this.decisions.push({
          timestamp: Date.now(),
          riskLevel,
          proposal,
          yieldData,
        })

        // Update current weights
        this.currentWeights[riskLevel] = proposal.weights

        // Cap decision history to prevent unbounded memory growth
        if (this.decisions.length > this.maxDecisionHistory) {
          this.decisions = this.decisions.slice(-this.maxDecisionHistory)
        }

        // TODO: Submit rebalance tx to on-chain allocator
        // TODO: Execute strategy trades based on weight changes
      }

      // 4. Scan DeFi yields (multi-protocol awareness)
      const marketScan = await scanDeFiYields()
      this.latestMarketScan = marketScan

      // 5. Record success
      this.monitor.recordCycleSuccess()

    } catch (error) {
      if (controller.signal.aborted) {
        this.monitor.recordCycleFailure('Cycle timeout (60s)')
      } else {
        this.monitor.recordCycleFailure(
          error instanceof Error ? error.message : 'Unknown error'
        )
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
