import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { DriftDataCache, parseFundingRate } from './data-api'
import type { RawFundingRate } from './data-api'

// Mock fetch globally for all tests
const mockFetch = vi.fn()
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = mockFetch
  mockFetch.mockReset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// --- parseFundingRate ---

describe('parseFundingRate', () => {
  it('converts raw funding rate to parsed format', () => {
    const raw: RawFundingRate = {
      slot: 100,
      fundingRate: '1000000000',    // 1.0 in PRICE_PRECISION
      oraclePriceTwap: '100000000', // 100.0 in ORACLE_PRECISION
      markPriceTwap: '101000000',
      fundingRateLong: '500000000',
      fundingRateShort: '500000000',
    }

    const parsed = parseFundingRate(raw)

    expect(parsed.slot).toBe(100)
    expect(parsed.oraclePrice).toBeCloseTo(100)
    expect(parsed.hourlyRate).toBeCloseTo(0.01)
    expect(parsed.annualizedApr).toBeCloseTo(0.01 * 24 * 365 * 100)
  })

  it('handles zero oracle price without division error', () => {
    const raw: RawFundingRate = {
      slot: 200,
      fundingRate: '1000000000',
      oraclePriceTwap: '0',
      markPriceTwap: '0',
      fundingRateLong: '0',
      fundingRateShort: '0',
    }

    const parsed = parseFundingRate(raw)

    expect(parsed.hourlyRate).toBe(0)
    expect(parsed.annualizedApr).toBe(0)
    expect(parsed.oraclePrice).toBe(0)
  })

  it('handles negative funding rate', () => {
    const raw: RawFundingRate = {
      slot: 300,
      fundingRate: '-500000000',
      oraclePriceTwap: '50000000',
      markPriceTwap: '49000000',
      fundingRateLong: '-250000000',
      fundingRateShort: '-250000000',
    }

    const parsed = parseFundingRate(raw)

    expect(parsed.hourlyRate).toBeLessThan(0)
    expect(parsed.annualizedApr).toBeLessThan(0)
  })
})

// --- DriftDataCache ---

describe('DriftDataCache', () => {
  let cache: DriftDataCache

  beforeEach(() => {
    // Use a short TTL for testing (100ms)
    cache = new DriftDataCache(100)
  })

  describe('getFundingRates', () => {
    it('fetches and caches funding rates', async () => {
      const mockRates: RawFundingRate[] = [{
        slot: 1,
        fundingRate: '1000000000',
        oraclePriceTwap: '100000000',
        markPriceTwap: '101000000',
        fundingRateLong: '500000000',
        fundingRateShort: '500000000',
      }]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fundingRates: mockRates }),
      })

      const result = await cache.getFundingRates('SOL-PERP')

      expect(result).toHaveLength(1)
      expect(result[0]!.slot).toBe(1)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns cached data on second call', async () => {
      const mockRates: RawFundingRate[] = [{
        slot: 1,
        fundingRate: '1000000000',
        oraclePriceTwap: '100000000',
        markPriceTwap: '101000000',
        fundingRateLong: '500000000',
        fundingRateShort: '500000000',
      }]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ fundingRates: mockRates }),
      })

      await cache.getFundingRates('SOL-PERP')
      const second = await cache.getFundingRates('SOL-PERP')

      expect(second).toHaveLength(1)
      // Only one fetch — second call hits cache
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('re-fetches after TTL expires', async () => {
      const mockRates: RawFundingRate[] = [{
        slot: 1,
        fundingRate: '1000000000',
        oraclePriceTwap: '100000000',
        markPriceTwap: '101000000',
        fundingRateLong: '500000000',
        fundingRateShort: '500000000',
      }]

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ fundingRates: mockRates }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ fundingRates: [{ ...mockRates[0], slot: 2 }] }),
        })

      await cache.getFundingRates('SOL-PERP')

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 120))

      const result = await cache.getFundingRates('SOL-PERP')

      expect(result[0]!.slot).toBe(2)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('caches different markets independently', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ fundingRates: [{ slot: 1, fundingRate: '1000000000', oraclePriceTwap: '100000000', markPriceTwap: '100000000', fundingRateLong: '0', fundingRateShort: '0' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ fundingRates: [{ slot: 2, fundingRate: '2000000000', oraclePriceTwap: '200000000', markPriceTwap: '200000000', fundingRateLong: '0', fundingRateShort: '0' }] }),
        })

      const sol = await cache.getFundingRates('SOL-PERP')
      const btc = await cache.getFundingRates('BTC-PERP')

      expect(sol[0]!.slot).toBe(1)
      expect(btc[0]!.slot).toBe(2)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(cache.size).toBe(2)
    })
  })

  describe('getDepositRate', () => {
    it('fetches and caches deposit rate', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [{ ts: 1000, rate: '0.05' }] }),
      })

      const rate = await cache.getDepositRate(0)

      expect(rate).toBeCloseTo(0.05)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns cached deposit rate on second call', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [{ ts: 1000, rate: '0.05' }] }),
      })

      await cache.getDepositRate(0)
      const second = await cache.getDepositRate(0)

      expect(second).toBeCloseTo(0.05)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns 0 when no rates available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [] }),
      })

      const rate = await cache.getDepositRate(0)

      expect(rate).toBe(0)
    })
  })

  describe('getBorrowRate', () => {
    it('fetches and caches borrow rate', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [{ ts: 1000, rate: '0.08' }] }),
      })

      const rate = await cache.getBorrowRate(0)

      expect(rate).toBeCloseTo(0.08)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('returns cached borrow rate on second call', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: [{ ts: 1000, rate: '0.08' }] }),
      })

      await cache.getBorrowRate(0)
      const second = await cache.getBorrowRate(0)

      expect(second).toBeCloseTo(0.08)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('clear', () => {
    it('clears all cached entries', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rates: [{ ts: 1000, rate: '0.05' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rates: [{ ts: 1000, rate: '0.08' }] }),
        })

      await cache.getDepositRate(0)
      await cache.getBorrowRate(0)

      expect(cache.size).toBe(2)

      cache.clear()

      expect(cache.size).toBe(0)
    })

    it('forces re-fetch after clear', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rates: [{ ts: 1000, rate: '0.05' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ rates: [{ ts: 2000, rate: '0.10' }] }),
        })

      await cache.getDepositRate(0)
      cache.clear()
      const rate = await cache.getDepositRate(0)

      expect(rate).toBeCloseTo(0.10)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('error propagation', () => {
    it('propagates API errors without caching', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      })

      await expect(cache.getDepositRate(0))
        .rejects.toThrow('Drift Data API error: 500 Internal Server Error')

      expect(cache.size).toBe(0)
    })

    it('propagates network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network timeout'))

      await expect(cache.getFundingRates('SOL-PERP'))
        .rejects.toThrow('network timeout')

      expect(cache.size).toBe(0)
    })
  })
})
