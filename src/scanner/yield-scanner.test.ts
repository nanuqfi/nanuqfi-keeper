import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { scanDeFiYields, fetchDeFiLlamaYields } from './yield-scanner'
import type { MarketScan, YieldOpportunity } from './yield-scanner'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLlamaPool(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'Solana',
    project: 'marginfi',
    symbol: 'USDC',
    tvlUsd: 500_000,
    apy: 8.5,
    stablecoin: true,
    ilRisk: 'no',
    ...overrides,
  }
}

function makeLlamaResponse(pools: ReturnType<typeof makeLlamaPool>[]) {
  return { status: 'success', data: pools }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// scanDeFiYields — full integration
// ---------------------------------------------------------------------------

describe('scanDeFiYields', () => {
  it('returns MarketScan structure with opportunities sorted by APY', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('llama.fi')) {
        return Promise.resolve({
          ok: true,
          json: async () => makeLlamaResponse([
            makeLlamaPool({ project: 'marginfi', apy: 8.5, tvlUsd: 500_000 }),
            makeLlamaPool({ project: 'kamino', apy: 12.0, tvlUsd: 1_000_000 }),
          ]),
        })
      }
      return Promise.reject(new Error('unexpected URL'))
    })

    const scan = await scanDeFiYields()

    expect(scan.timestamp).toBeGreaterThan(0)
    expect(scan.opportunities.length).toBeGreaterThanOrEqual(2)

    // Sorted descending by APY
    for (let i = 1; i < scan.opportunities.length; i++) {
      expect(scan.opportunities[i - 1]!.apy).toBeGreaterThanOrEqual(scan.opportunities[i]!.apy)
    }

    // bestByRisk populated
    expect(scan.bestByRisk.low).not.toBeNull()

    // driftComparison shape present for API compatibility
    expect(scan.driftComparison.totalScanned).toBeGreaterThan(0)
  })

  it('bestByRisk picks the highest-APY opportunity per risk tier', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('llama.fi')) {
        return Promise.resolve({
          ok: true,
          json: async () => makeLlamaResponse([
            makeLlamaPool({ project: 'a', apy: 5.0, ilRisk: 'no' }),   // low risk
            makeLlamaPool({ project: 'b', apy: 10.0, ilRisk: 'no' }),  // low risk, higher
            makeLlamaPool({ project: 'c', apy: 15.0, ilRisk: 'yes' }), // medium risk
          ]),
        })
      }
      return Promise.reject(new Error('offline'))
    })

    const scan = await scanDeFiYields()

    // Sorted by APY — medium (15%) first, then low (10%), then low (5%)
    // bestByRisk.low = the first 'low' in sorted order = 'b' at 10%
    expect(scan.bestByRisk.low?.protocol).toBe('b')
    expect(scan.bestByRisk.medium?.protocol).toBe('c')
  })

  it('handles DeFi Llama API failure gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'))

    const scan = await scanDeFiYields()

    expect(scan.opportunities).toHaveLength(0)
    expect(scan.bestByRisk.low).toBeNull()
    expect(scan.driftComparison.driftBestApy).toBe(0)
    expect(scan.driftComparison.marketBestApy).toBe(0)
    expect(scan.driftComparison.totalScanned).toBe(0)
  })

  it('handles all APIs failing without crashing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('all down'))

    const scan = await scanDeFiYields()

    expect(scan.opportunities).toHaveLength(0)
    expect(scan.bestByRisk.low).toBeNull()
    expect(scan.bestByRisk.medium).toBeNull()
    expect(scan.bestByRisk.high).toBeNull()
    expect(scan.driftComparison.driftBestApy).toBe(0)
    expect(scan.driftComparison.marketBestApy).toBe(0)
    expect(scan.driftComparison.totalScanned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// fetchDeFiLlamaYields — filtering
// ---------------------------------------------------------------------------

describe('fetchDeFiLlamaYields', () => {
  it('filters Solana-only stablecoin yields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeLlamaResponse([
        makeLlamaPool({ chain: 'Solana', stablecoin: true, apy: 8.0, tvlUsd: 200_000 }),
        makeLlamaPool({ chain: 'Ethereum', stablecoin: true, apy: 15.0, tvlUsd: 1_000_000 }),
        makeLlamaPool({ chain: 'Solana', stablecoin: false, apy: 30.0, tvlUsd: 500_000 }),
        makeLlamaPool({ chain: 'Solana', stablecoin: true, apy: 5.0, tvlUsd: 50_000 }),  // TVL too low
        makeLlamaPool({ chain: 'Solana', stablecoin: true, apy: 0, tvlUsd: 500_000 }),    // zero APY
      ]),
    })

    const results = await fetchDeFiLlamaYields()

    // Only the first pool passes all filters
    expect(results).toHaveLength(1)
    expect(results[0]!.apy).toBe(0.08) // 8% / 100
  })

  it('classifies risk based on ilRisk and APY', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeLlamaResponse([
        makeLlamaPool({ ilRisk: 'no', apy: 5.0 }),    // low
        makeLlamaPool({ ilRisk: 'yes', apy: 10.0 }),   // medium
        makeLlamaPool({ ilRisk: 'yes', apy: 25.0 }),   // high (>20%)
      ]),
    })

    const results = await fetchDeFiLlamaYields()

    expect(results[0]!.risk).toBe('low')
    expect(results[1]!.risk).toBe('medium')
    expect(results[2]!.risk).toBe('high')
  })

  it('limits results to 50 opportunities', async () => {
    const pools = Array.from({ length: 100 }, (_, i) =>
      makeLlamaPool({ project: `pool-${i}`, apy: 5 + i * 0.1 })
    )
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeLlamaResponse(pools),
    })

    const results = await fetchDeFiLlamaYields()
    expect(results.length).toBeLessThanOrEqual(50)
  })

  it('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })

    await expect(fetchDeFiLlamaYields()).rejects.toThrow('DeFi Llama error: 500')
  })
})
