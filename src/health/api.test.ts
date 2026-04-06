import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApi, type KeeperDataSource, type VaultSnapshot, type DecisionLog } from './api'
import { HealthMonitor } from './monitor'

const conservativeWeights: Record<string, number> = { lending: 6000, insurance: 4000 }
const moderateWeights: Record<string, number> = { lending: 2500, basis: 4000, insurance: 2000, jito: 1500 }

const mockData: KeeperDataSource = {
  getVaults: () => [
    { riskLevel: 'conservative', tvl: 100000, apy: 0.10, weights: conservativeWeights, drawdown: 0.005 },
    { riskLevel: 'moderate', tvl: 250000, apy: 0.18, weights: moderateWeights, drawdown: 0.02 },
  ],
  getVault: (level: string) => mockData.getVaults().find(v => v.riskLevel === level),
  getHistory: (_level: string, limit = 50) => Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
    timestamp: Date.now() - i * 3600_000,
    action: 'rebalance',
    previousWeights: { lending: 5000, insurance: 5000 },
    newWeights: { lending: 6000, insurance: 4000 },
    algoScores: { lending: 1.2, insurance: 0.8 },
    aiInvolved: false,
    guardrailPassed: true,
  })),
  getDecisions: (_level: string, limit = 10) => mockData.getHistory(_level, limit),
  getYields: () => ({ lending: 0.08, insurance: 0.12, basis: 0.20, funding: 0.30, jito: 0.22 }),
}

describe('Keeper REST API', () => {
  const monitor = new HealthMonitor()
  const api = createApi(monitor, mockData, 0) // port 0 = random
  let port: number

  beforeAll(async () => {
    await api.start()
    const addr = api.server.address()
    port = typeof addr === 'object' && addr ? addr.port : 3001
  })

  afterAll(async () => {
    await api.stop()
  })

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      const res = await fetch(`http://localhost:${port}${path}`, { signal: controller.signal })
      const body = await res.json()
      return { status: res.status, body }
    } finally {
      clearTimeout(timeout)
    }
  }

  it('GET /v1/health returns health status', async () => {
    const { status, body } = await get('/v1/health')
    expect(status).toBe(200)
    expect(body).toHaveProperty('uptime')
    expect(body).toHaveProperty('aiLayerStatus')
  })

  it('GET /v1/vaults returns all vaults', async () => {
    const { status, body } = await get('/v1/vaults')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect((body as VaultSnapshot[]).length).toBe(2)
  })

  it('GET /v1/vaults/conservative returns single vault', async () => {
    const { status, body } = await get('/v1/vaults/conservative')
    expect(status).toBe(200)
    expect((body as VaultSnapshot).riskLevel).toBe('conservative')
  })

  it('GET /v1/vaults/unknown returns 404', async () => {
    const { status } = await get('/v1/vaults/unknown')
    expect(status).toBe(404)
  })

  it('GET /v1/vaults/moderate/history returns history', async () => {
    const { status, body } = await get('/v1/vaults/moderate/history?limit=2')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect((body as DecisionLog[]).length).toBeLessThanOrEqual(2)
  })

  it('GET /v1/vaults/moderate/decisions returns decisions', async () => {
    const { status, body } = await get('/v1/vaults/moderate/decisions')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /v1/yields returns yield estimates', async () => {
    const { status, body } = await get('/v1/yields')
    expect(status).toBe(200)
    expect(body).toHaveProperty('lending')
    expect(body).toHaveProperty('basis')
  })

  it('GET /v1/status returns status with version', async () => {
    const { status, body } = await get('/v1/status')
    expect(status).toBe(200)
    expect(body).toHaveProperty('version', '0.1.0')
  })

  it('GET /unknown returns 404', async () => {
    const { status } = await get('/unknown')
    expect(status).toBe(404)
  })

  it('GET /v1/market-scan returns empty scan when no data', async () => {
    const { status, body } = await get('/v1/market-scan')
    expect(status).toBe(200)
    // mockData has no getMarketScan, so returns fallback
    expect(body).toHaveProperty('status', 'no scan yet')
  })

  it('GET /v1/decisions returns empty array when no data', async () => {
    const { status, body } = await get('/v1/decisions')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[]).length).toBe(0)
  })
})

// Test with enriched data source that provides market scan + keeper decisions
describe('Keeper REST API — enriched endpoints', () => {
  const monitor = new HealthMonitor()
  const enrichedData: KeeperDataSource = {
    ...mockData,
    getMarketScan: () => ({
      timestamp: 1710500000000,
      opportunities: [
        { protocol: 'kamino', strategy: 'USDC', asset: 'USDC', apy: 0.065, tvl: 500_000, risk: 'low' as const, source: 'defillama' },
        { protocol: 'marginfi', strategy: 'USDC', asset: 'USDC', apy: 0.08, tvl: 500_000, risk: 'low' as const, source: 'defillama' },
      ],
      bestByRisk: {
        low: { protocol: 'marginfi', strategy: 'USDC', asset: 'USDC', apy: 0.08, tvl: 500_000, risk: 'low' as const, source: 'defillama' },
        medium: null,
        high: null,
      },
      driftComparison: { driftBestApy: 0, marketBestApy: 0.08, driftRank: 3, totalScanned: 2 },
    }),
    getKeeperDecisions: (limit = 20) => [
      {
        timestamp: 1710500000000,
        riskLevel: 'moderate',
        proposal: { weights: { 'kamino-lending': 6000, 'marginfi-lending': 4000 }, excludedBackends: [], scores: { 'kamino-lending': 0.4, 'marginfi-lending': 0.3 } },
        yieldData: { kaminoSupplyRate: 0.021, marginfiLendingRate: 0.065, luloRegularRate: 0.07 },
      },
    ].slice(0, limit),
    getLatestYieldData: () => ({
      kaminoSupplyRate: 0.021,
      marginfiLendingRate: 0.065,
      luloRegularRate: 0.07,
    }),
    getBacktestResult: async () => ({
      totalReturn: 0.15,
      cagr: 0.065,
      maxDrawdown: 0.002,
      sharpeRatio: 8.5,
      sortinoRatio: 12.0,
      volatility: 0.003,
      protocols: {
        'kamino-lending': { totalReturn: 0.10, cagr: 0.05, maxDrawdown: 0.001, sharpeRatio: 7.0 },
        'marginfi-lending': { totalReturn: 0.12, cagr: 0.06, maxDrawdown: 0.001, sharpeRatio: 8.0 },
        'lulo-lending': { totalReturn: 0.14, cagr: 0.065, maxDrawdown: 0.002, sharpeRatio: 8.5 },
      },
      series: [],
      startDate: '2023-10-12',
      endDate: '2026-04-06',
      dataPoints: 21000,
      riskFreeRate: 0.04,
    }),
  }

  const api = createApi(monitor, enrichedData, 0)
  let port: number

  beforeAll(async () => {
    await api.start()
    const addr = api.server.address()
    port = typeof addr === 'object' && addr ? addr.port : 3001
  })

  afterAll(async () => {
    await api.stop()
  })

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      const res = await fetch(`http://localhost:${port}${path}`, { signal: controller.signal })
      const body = await res.json()
      return { status: res.status, body }
    } finally {
      clearTimeout(timeout)
    }
  }

  it('GET /v1/market-scan returns scan with opportunities', async () => {
    const { status, body } = await get('/v1/market-scan')
    expect(status).toBe(200)
    const scan = body as { opportunities: unknown[]; driftComparison: { driftRank: number } }
    expect(scan.opportunities).toHaveLength(2)
    expect(scan.driftComparison.driftRank).toBe(3)
  })

  it('GET /v1/decisions returns keeper decisions', async () => {
    const { status, body } = await get('/v1/decisions')
    expect(status).toBe(200)
    const decisions = body as { riskLevel: string }[]
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.riskLevel).toBe('moderate')
  })

  it('GET /v1/decisions respects limit parameter', async () => {
    const { status, body } = await get('/v1/decisions?limit=0')
    expect(status).toBe(200)
    expect((body as unknown[]).length).toBe(0)
  })

  it('GET /v1/yields includes live yield data when available', async () => {
    const { status, body } = await get('/v1/yields')
    expect(status).toBe(200)
    const yields = body as Record<string, unknown>
    // Original yields still present
    expect(yields).toHaveProperty('lending')
    expect(yields).toHaveProperty('basis')
    // Live data merged
    expect(yields).toHaveProperty('live')
    const live = yields.live as Record<string, unknown>
    expect(live).toHaveProperty('kaminoSupplyRate', 0.021)
    expect(live).toHaveProperty('marginfiLendingRate', 0.065)
  })

  it('GET /v1/backtest returns simulation results', async () => {
    const { status, body } = await get('/v1/backtest')
    expect(status).toBe(200)
    const result = body as { totalReturn: number; sharpeRatio: number; protocols: Record<string, unknown> }
    expect(result.totalReturn).toBe(0.15)
    expect(result.sharpeRatio).toBe(8.5)
    expect(result.protocols['kamino-lending']).toBeDefined()
  })
})
