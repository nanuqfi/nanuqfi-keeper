import { loadConfig } from './config.js'
import { HealthMonitor } from './health/monitor.js'
import { createApi } from './health/api.js'
import { Keeper } from './keeper.js'
import type { KeeperDataSource } from './health/api.js'

const config = loadConfig()
const monitor = new HealthMonitor()
const keeper = new Keeper({ config, monitor })

const dataSource: KeeperDataSource = {
  getVaults: () => [],
  getVault: () => undefined,
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
        aiInvolved: true,
        guardrailPassed: true,
      }
    })
  },
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
  console.log(`[NanuqFi Keeper] Drift env: ${config.drift?.env ?? 'none'}`)

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

process.on('SIGTERM', async () => {
  console.log('[NanuqFi Keeper] Shutting down...')
  keeper.stop()
  await api.stop()
  process.exit(0)
})

main()
