import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { HealthMonitor } from './monitor.js'
import type { MarketScan } from '../scanner/index.js'
import type { KeeperDecision, YieldData } from '../keeper.js'

export interface VaultSnapshot {
  riskLevel: string
  tvl: number
  apy: number
  weights: Record<string, number>
  drawdown: number
}

export interface DecisionLog {
  timestamp: number
  action: string
  previousWeights: Record<string, number>
  newWeights: Record<string, number>
  algoScores: Record<string, number>
  aiInvolved: boolean
  aiReasoning?: string
  guardrailPassed: boolean
  txSignature?: string
}

export interface KeeperDataSource {
  getVaults(): VaultSnapshot[]
  getVault(riskLevel: string): VaultSnapshot | undefined
  getHistory(riskLevel: string, limit?: number): DecisionLog[]
  getDecisions(riskLevel: string, limit?: number): DecisionLog[]
  getYields(): Record<string, number>
  getMarketScan?(): MarketScan | null
  getKeeperDecisions?(limit?: number): KeeperDecision[]
  getLatestYieldData?(): YieldData | null
}

export function createApi(
  monitor: HealthMonitor,
  data: KeeperDataSource,
  port = 3001,
) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')

    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const path = url.pathname

    try {
      if (path === '/v1/health') {
        respond(res, 200, monitor.getStatus())
      } else if (path === '/v1/vaults') {
        respond(res, 200, data.getVaults())
      } else if (path.match(/^\/v1\/vaults\/(conservative|moderate|aggressive)$/)) {
        const level = path.split('/')[3]
        const vault = data.getVault(level)
        if (!vault) return respond(res, 404, { error: 'Vault not found' })
        respond(res, 200, vault)
      } else if (path.match(/^\/v1\/vaults\/(conservative|moderate|aggressive)\/history$/)) {
        const level = path.split('/')[3]
        const limit = Number(url.searchParams.get('limit') ?? 50)
        respond(res, 200, data.getHistory(level, limit))
      } else if (path.match(/^\/v1\/vaults\/(conservative|moderate|aggressive)\/decisions$/)) {
        const level = path.split('/')[3]
        const limit = Number(url.searchParams.get('limit') ?? 10)
        respond(res, 200, data.getDecisions(level, limit))
      } else if (path === '/v1/yields') {
        // Enhanced: return live yield data if available, fall back to static yields
        const liveYields = data.getLatestYieldData?.()
        if (liveYields) {
          respond(res, 200, {
            ...data.getYields(),
            live: liveYields,
          })
        } else {
          respond(res, 200, data.getYields())
        }
      } else if (path === '/v1/market-scan') {
        const scan = data.getMarketScan?.() ?? null
        if (!scan) {
          respond(res, 200, { status: 'no scan yet', scan: null })
        } else {
          respond(res, 200, scan)
        }
      } else if (path === '/v1/decisions') {
        const limit = Number(url.searchParams.get('limit') ?? 20)
        const decisions = data.getKeeperDecisions?.(limit) ?? []
        respond(res, 200, decisions)
      } else if (path === '/v1/status') {
        respond(res, 200, {
          ...monitor.getStatus(),
          version: '0.1.0',
        })
      } else {
        respond(res, 404, { error: 'Not found' })
      }
    } catch (err) {
      respond(res, 500, { error: 'Internal server error' })
    }
  })

  return {
    start: () => new Promise<void>(resolve => {
      server.listen(port, () => resolve())
    }),
    stop: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    }),
    server,
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status)
  res.end(JSON.stringify(body))
}
