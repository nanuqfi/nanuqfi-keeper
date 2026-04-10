import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { HealthMonitor } from './monitor.js'
import type { MarketScan } from '../scanner/index.js'
import type { KeeperDecision, YieldData } from '../keeper.js'
import type { BacktestResult } from '../backtest/index.js'

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
  getAIInsight?(): import('../ai/index.js').AIInsight | null
  getAIHistory?(limit?: number): import('../ai/index.js').AIInsight[]
  getBacktestResult?(): Promise<BacktestResult | null>
  getCurrentWeights?(): Record<string, Record<string, number>>
}

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',').map(s => s.trim())
)

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60 // 60 requests per minute

const requestCounts = new Map<string, { count: number; resetAt: number }>()

// Periodic cleanup of expired rate limit entries (prevent unbounded growth)
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip)
  }
}, 300_000)

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = requestCounts.get(ip)

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

export function createApi(
  monitor: HealthMonitor,
  data: KeeperDataSource,
  port = 3001,
) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json')
    const origin = req.headers.origin ?? ''
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    } else if (ALLOWED_ORIGINS.has('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-XSS-Protection', '1; mode=block')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

    const ip = req.socket.remoteAddress ?? 'unknown'
    if (isRateLimited(ip)) {
      respond(res, 429, { error: 'Too many requests' })
      return
    }

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
        const rawLimit = Number(url.searchParams.get('limit') ?? 50)
        const limit = Math.min(Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 50, 100)
        respond(res, 200, data.getHistory(level, limit))
      } else if (path.match(/^\/v1\/vaults\/(conservative|moderate|aggressive)\/decisions$/)) {
        const level = path.split('/')[3]
        const rawLimit = Number(url.searchParams.get('limit') ?? 10)
        const limit = Math.min(Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 10, 100)
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
        const rawLimit = Number(url.searchParams.get('limit') ?? 20)
        const limit = Math.min(Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 20, 100)
        const decisions = data.getKeeperDecisions?.(limit) ?? []
        respond(res, 200, decisions)
      } else if (path === '/v1/status') {
        respond(res, 200, {
          ...monitor.getStatus(),
          version: '0.1.0',
        })
      } else if (path === '/v1/ai') {
        const insight = data.getAIInsight?.() ?? null
        respond(res, 200, {
          available: insight !== null,
          insight,
        })
      } else if (path === '/v1/ai/history') {
        const rawLimit = Number(url.searchParams.get('limit') ?? 20)
        const limit = Math.min(Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 20, 100)
        const history = data.getAIHistory?.(limit) ?? []
        respond(res, 200, history)
      } else if (path === '/v1/metrics') {
        const status = monitor.getStatus()
        const totalCycles = status.cyclesCompleted + status.cyclesFailed
        const failureRate = totalCycles > 0 ? status.cyclesFailed / totalCycles : 0
        const lastDecisions = data.getKeeperDecisions?.(1) ?? []
        const lastRebalanceTimestamp = lastDecisions[0]?.timestamp ?? null
        const aiInsight = data.getAIInsight?.() ?? null
        const weights = data.getCurrentWeights?.() ?? {}

        // Summarise rate limit stats from the current request counts snapshot
        const rateLimitStats = {
          windowMs: RATE_LIMIT_WINDOW_MS,
          maxPerWindow: RATE_LIMIT_MAX,
          activeIps: requestCounts.size,
        }

        respond(res, 200, {
          uptime: status.uptime,
          cycleCount: status.cyclesCompleted,
          failureRate: Math.round(failureRate * 10000) / 10000,
          lastRebalanceTimestamp,
          weights,
          aiLayer: {
            status: status.aiLayerStatus,
            lastInsightTimestamp: aiInsight?.timestamp ?? null,
            regime: aiInsight?.regime ?? null,
          },
          rpcStatus: status.rpcStatus,
          rateLimitStats,
        })
      } else if (path === '/v1/backtest') {
        const backtestPromise = data.getBacktestResult
          ? data.getBacktestResult()
          : Promise.resolve(null)
        backtestPromise
          .then(result => {
            if (result) {
              respond(res, 200, result)
            } else {
              respond(res, 503, { error: 'Backtest not available' })
            }
          })
          .catch(() => {
            respond(res, 500, { error: 'Backtest computation failed' })
          })
        return
      } else {
        respond(res, 404, { error: 'Not found' })
      }
    } catch (err) {
      console.error('[API] Request handler error:', err)
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
