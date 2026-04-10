import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMarginfiRate, MARGINFI_FALLBACK_RATE } from '../rates/marginfi.js'

const originalFetch = globalThis.fetch

describe('fetchMarginfiRate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns live APY from DeFi Llama when USDC pool found', async () => {
    const mockPools = [
      { project: 'aave', symbol: 'USDC', chain: 'Ethereum', apy: 3.2 },
      { project: 'marginfi', symbol: 'USDC', chain: 'Solana', apy: 7.5 },
      { project: 'marginfi', symbol: 'SOL', chain: 'Solana', apy: 5.0 },
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockPools }),
    })

    const rate = await fetchMarginfiRate()

    // 7.5% → 0.075
    expect(rate).toBeCloseTo(0.075)
  })

  it('returns fallback when DeFi Llama returns non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    })

    const rate = await fetchMarginfiRate()

    expect(rate).toBe(MARGINFI_FALLBACK_RATE)
  })

  it('returns fallback when network throws (timeout / DNS failure)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'))

    const rate = await fetchMarginfiRate()

    expect(rate).toBe(MARGINFI_FALLBACK_RATE)
  })

  it('returns fallback when Marginfi USDC pool not found in response', async () => {
    const mockPools = [
      { project: 'kamino', symbol: 'USDC', chain: 'Solana', apy: 4.5 },
      { project: 'marginfi', symbol: 'SOL', chain: 'Solana', apy: 5.0 },
      // No marginfi USDC pool
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockPools }),
    })

    const rate = await fetchMarginfiRate()

    expect(rate).toBe(MARGINFI_FALLBACK_RATE)
  })

  it('returns fallback when response has no data field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'internal server error' }),
    })

    const rate = await fetchMarginfiRate()

    expect(rate).toBe(MARGINFI_FALLBACK_RATE)
  })

  it('returns fallback when pool apy is not a number', async () => {
    const mockPools = [
      { project: 'marginfi', symbol: 'USDC', chain: 'Solana', apy: null },
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockPools }),
    })

    const rate = await fetchMarginfiRate()

    expect(rate).toBe(MARGINFI_FALLBACK_RATE)
  })

  it('converts percentage to decimal correctly (8.29% → 0.0829)', async () => {
    const mockPools = [
      { project: 'marginfi', symbol: 'USDC', chain: 'Solana', apy: 8.29 },
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockPools }),
    })

    const rate = await fetchMarginfiRate()

    expect(rate).toBeCloseTo(0.0829, 4)
  })
})
