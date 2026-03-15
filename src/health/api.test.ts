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
})
