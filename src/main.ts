import { loadConfig } from './config.js'
import { HealthMonitor } from './health/monitor.js'
import { createApi } from './health/api.js'
import { Keeper } from './keeper.js'
import { AIProvider } from './ai/index.js'
import type { KeeperDataSource } from './health/api.js'

const config = loadConfig()
const monitor = new HealthMonitor()
const ai = config.aiApiKey
  ? new AIProvider({
      apiKey: config.aiApiKey,
      baseURL: config.aiBaseURL,
      model: config.aiModel,
      maxCallsPerHour: config.aiMaxCallsPerHour,
      budgetPerDay: config.aiBudgetPerDay,
    })
  : undefined
const keeper = new Keeper({ config, monitor, ai })

const dataSource: KeeperDataSource = {
  getVaults: () => keeper.getVaultSnapshots(),
  getVault: (level: string) => keeper.getVaultSnapshot(level),
  getHistory: () => [],
  getDecisions: (level?: string, limit?: number) => {
    const all = keeper.getDecisions()
    const filtered = level ? all.filter(d => d.riskLevel === level) : all
    const limited = filtered.slice(-(limit ?? 10))
    return limited.map((d, i) => {
      const prev = i > 0 ? limited[i - 1] : null
      return {
        timestamp: d.timestamp,
        action: 'Rebalance',
        previousWeights: prev?.proposal.weights ?? {},
        newWeights: d.proposal.weights,
        algoScores: d.proposal.scores ?? {},
        aiInvolved: !!d.aiInsight,
        aiReasoning: d.aiInsight?.reasoning,
        guardrailPassed: true,
      }
    })
  },
  getAIInsight: () => keeper.getAIInsight(),
  getAIHistory: (limit?: number) => keeper.getAIHistory(limit),
  getBacktestResult: () => keeper.getBacktestResult(),
  getCurrentWeights: () => keeper.getCurrentWeights(),
  getYields: () => ({}),
  getMarketScan: () => keeper.getMarketScan() ?? null,
  getKeeperDecisions: (limit?: number) => keeper.getDecisions().slice(-(limit ?? 50)),
  getLatestYieldData: () => keeper.getYieldData() ?? null,
}

const port = Number(process.env.PORT ?? 3000)
const api = createApi(monitor, dataSource, port)

async function main() {
  console.log(`[NanuqFi Keeper] Starting on port ${port}...`)
  console.log(`[NanuqFi Keeper] Cycle interval: ${config.cycleIntervalMs / 1000}s`)
  console.log(`[NanuqFi Keeper] AI layer: ${ai ? 'enabled' : 'disabled (no API key)'}`)
  if (ai) {
    console.log(`[NanuqFi Keeper] AI cycle interval: ${config.aiCycleIntervalMs / 1000}s`)
  }

  await api.start()
  console.log(`[NanuqFi Keeper] API listening on port ${port}`)

  try {
    await keeper.start()
    console.log('[NanuqFi Keeper] Keeper started successfully')
  } catch (err) {
    console.error('[NanuqFi Keeper] Failed to start keeper:', err)
    console.log('[NanuqFi Keeper] Running in degraded mode — API only')
  }
}

let isShuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[NanuqFi Keeper] Received ${signal}, shutting down gracefully...`)

  // Stop the cycle loop — prevents new cycles from starting
  keeper.stop()

  // Close the HTTP server — stops accepting new connections
  try {
    await api.stop()
  } catch (err) {
    console.warn('[NanuqFi Keeper] API server close error:', err)
  }

  // Allow pending operations up to 5s, then force exit
  const forceExit = setTimeout(() => {
    console.log('[NanuqFi Keeper] Force exit after grace period')
    process.exit(0)
  }, 5_000)
  // Don't let this timer keep the process alive — let it exit naturally if clean
  forceExit.unref()
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })

main()
