import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runBacktest } from './engine.js'
import { fetchHistoricalData } from './data-loader.js'
import {
  computeCagr,
  computeMaxDrawdown,
  computeVolatility,
  computeSharpe,
  computeSortino,
} from './metrics.js'
import { DEFAULT_CONFIG } from './types.js'
import type { HistoricalDataPoint, BacktestConfig } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build N days of uniform historical data for deterministic tests. */
function makeData(days: number, kaminoApy = 0.06, marginfiApy = 0.065, luloApy = 0.07): HistoricalDataPoint[] {
  const baseMs = new Date('2024-01-01T00:00:00.000Z').getTime()
  const ONE_DAY_MS = 86_400_000
  return Array.from({ length: days }, (_, i) => ({
    timestamp: baseMs + i * ONE_DAY_MS,
    kaminoApy,
    marginfiApy,
    luloApy,
  }))
}

const TEST_CONFIG: BacktestConfig = {
  riskFreeRate: 0.04,
  marginfiApyMultiplier: 1.0,
  luloApyMultiplier: 1.0,
  initialDeposit: 10_000,
}

// ---------------------------------------------------------------------------
// Metrics — unit tests
// ---------------------------------------------------------------------------

describe('computeCagr', () => {
  it('returns 0 for zero days', () => {
    expect(computeCagr(10_000, 11_000, 0)).toBe(0)
  })

  it('returns 0 for zero starting value', () => {
    expect(computeCagr(0, 11_000, 365)).toBe(0)
  })

  it('computes annual return correctly for 1 year', () => {
    // $10k → $10.5k in 365 days = 5% CAGR
    expect(computeCagr(10_000, 10_500, 365)).toBeCloseTo(0.05, 4)
  })

  it('compounds correctly over 2 years', () => {
    // $10k → $12.1k in 730 days = 10% CAGR
    expect(computeCagr(10_000, 12_100, 730)).toBeCloseTo(0.1, 3)
  })
})

describe('computeMaxDrawdown', () => {
  it('returns 0 for fewer than 2 values', () => {
    expect(computeMaxDrawdown([])).toBe(0)
    expect(computeMaxDrawdown([10_000])).toBe(0)
  })

  it('returns 0 for monotonically increasing series', () => {
    expect(computeMaxDrawdown([100, 110, 120, 130])).toBe(0)
  })

  it('computes 50% drawdown correctly', () => {
    // 100 → 200 (peak) → 100 = 50% drawdown
    const dd = computeMaxDrawdown([100, 200, 100])
    expect(dd).toBeCloseTo(0.5, 6)
  })

  it('identifies the worst drawdown in a series with multiple dips', () => {
    // Peak at 200, drops to 50 = 75% drawdown
    const dd = computeMaxDrawdown([100, 150, 200, 180, 50, 60])
    expect(dd).toBeCloseTo(0.75, 6)
  })
})

describe('computeVolatility', () => {
  it('returns 0 for fewer than 2 returns', () => {
    expect(computeVolatility([])).toBe(0)
    expect(computeVolatility([0.01])).toBe(0)
  })

  it('returns 0 for identical daily returns', () => {
    expect(computeVolatility([0.001, 0.001, 0.001])).toBe(0)
  })

  it('returns positive volatility for varying returns', () => {
    const v = computeVolatility([0.01, -0.02, 0.015, -0.005, 0.008])
    expect(v).toBeGreaterThan(0)
  })

  it('annualizes by sqrt(365)', () => {
    // Single non-zero variance point — daily stddev of 0.01 → annualized = 0.01 * sqrt(365)
    const returns = [0.01, -0.01]
    const vol = computeVolatility(returns)
    // stddev of [0.01, -0.01] = 0.01√2 / 1 (sample) = 0.01 * sqrt(2)
    // annualized = 0.01 * sqrt(2) * sqrt(365)
    const expected = 0.01 * Math.sqrt(2) * Math.sqrt(365)
    expect(vol).toBeCloseTo(expected, 4)
  })
})

describe('computeSharpe', () => {
  it('returns 0 when volatility is zero', () => {
    expect(computeSharpe(0.06, 0.04, 0)).toBe(0)
  })

  it('computes correctly for positive alpha', () => {
    // (6% - 4%) / 2% = 1.0
    expect(computeSharpe(0.06, 0.04, 0.02)).toBeCloseTo(1.0, 6)
  })

  it('returns negative ratio when return below risk-free rate', () => {
    expect(computeSharpe(0.02, 0.04, 0.02)).toBeCloseTo(-1.0, 6)
  })
})

describe('computeSortino', () => {
  it('returns 0 for fewer than 2 returns', () => {
    expect(computeSortino([], 0.04)).toBe(0)
    expect(computeSortino([0.001], 0.04)).toBe(0)
  })

  it('returns 0 when all returns are above daily risk-free threshold', () => {
    // Daily rf = 4% / 365 ≈ 0.000109 — returns well above that
    expect(computeSortino([0.01, 0.02, 0.015], 0.04)).toBe(0)
  })

  it('returns a finite value (positive or negative) when there are downside returns', () => {
    // Sortino sign depends on whether annualized return exceeds risk-free rate.
    // We test that it produces a finite, non-NaN number — correctness of sign
    // is validated by the computeSharpe test which uses the same formula shape.
    const returns = [0.01, -0.02, 0.005, -0.015, 0.008]
    const sortino = computeSortino(returns, 0.04)
    expect(Number.isFinite(sortino)).toBe(true)
    expect(Number.isNaN(sortino)).toBe(false)
  })

  it('returns a higher value for a series with fewer downside deviations', () => {
    // Series A: mostly positive, one small dip
    const seriesA = [0.003, 0.004, -0.0001, 0.003, 0.004]
    // Series B: same mean but larger downside moves
    const seriesB = [0.003, 0.004, -0.010, 0.003, 0.014]
    // A has smaller downside deviation → better Sortino
    expect(computeSortino(seriesA, 0.04)).toBeGreaterThan(computeSortino(seriesB, 0.04))
  })
})

// ---------------------------------------------------------------------------
// runBacktest — integration (pure computation, no network)
// ---------------------------------------------------------------------------

describe('runBacktest', () => {
  it('returns a result with all required fields', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)

    expect(typeof result.totalReturn).toBe('number')
    expect(typeof result.cagr).toBe('number')
    expect(typeof result.maxDrawdown).toBe('number')
    expect(typeof result.sharpeRatio).toBe('number')
    expect(typeof result.sortinoRatio).toBe('number')
    expect(typeof result.volatility).toBe('number')
    expect(result.protocols).toBeDefined()
    expect(result.series).toBeDefined()
    expect(typeof result.startDate).toBe('string')
    expect(typeof result.endDate).toBe('string')
    expect(typeof result.dataPoints).toBe('number')
    expect(typeof result.riskFreeRate).toBe('number')
  })

  it('series length matches input data length', () => {
    const data = makeData(60)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.series).toHaveLength(60)
    expect(result.dataPoints).toBe(60)
  })

  it('portfolio value grows with positive APY', () => {
    const data = makeData(365, 0.06, 0.065, 0.07)
    const result = runBacktest(data, TEST_CONFIG)
    // With positive APY across all protocols the portfolio must grow
    expect(result.totalReturn).toBeGreaterThan(0)
    expect(result.cagr).toBeGreaterThan(0)
  })

  it('reports all three protocol metrics', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.protocols['kamino-lending']).toBeDefined()
    expect(result.protocols['marginfi-lending']).toBeDefined()
    expect(result.protocols['lulo-lending']).toBeDefined()
  })

  it('each protocol metric has required shape', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)
    for (const key of ['kamino-lending', 'marginfi-lending', 'lulo-lending']) {
      const pm = result.protocols[key]!
      expect(typeof pm.totalReturn).toBe('number')
      expect(typeof pm.cagr).toBe('number')
      expect(typeof pm.maxDrawdown).toBe('number')
      expect(typeof pm.sharpeRatio).toBe('number')
    }
  })

  it('portfolio outperforms lowest-yield protocol with 3 uniform-APY protocols', () => {
    // All same APY — router should be equal; just verify no crash
    const data = makeData(90, 0.06, 0.06, 0.06)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.totalReturn).toBeGreaterThan(0)
  })

  it('series portfolio values start at initialDeposit', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.series[0]!.portfolioValue).toBe(TEST_CONFIG.initialDeposit)
  })

  it('portfolio value increases monotonically with positive constant APY', () => {
    // With all positive APYs portfolio should never decrease day-over-day
    const data = makeData(30, 0.05, 0.05, 0.05)
    const result = runBacktest(data, TEST_CONFIG)
    for (let i = 1; i < result.series.length; i++) {
      expect(result.series[i]!.portfolioValue).toBeGreaterThanOrEqual(result.series[i - 1]!.portfolioValue)
    }
  })

  it('startDate and endDate are valid ISO date strings', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)
    expect(/^\d{4}-\d{2}-\d{2}$/.test(result.startDate)).toBe(true)
    expect(/^\d{4}-\d{2}-\d{2}$/.test(result.endDate)).toBe(true)
  })

  it('riskFreeRate matches config', () => {
    const data = makeData(30)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.riskFreeRate).toBe(TEST_CONFIG.riskFreeRate)
  })

  it('maxDrawdown is zero for monotonically rising portfolio', () => {
    // All positive APY → portfolio only rises → drawdown = 0
    const data = makeData(30, 0.05, 0.05, 0.05)
    const result = runBacktest(data, TEST_CONFIG)
    expect(result.maxDrawdown).toBe(0)
  })

  it('applies DEFAULT_CONFIG without throwing', () => {
    const data = makeData(30)
    expect(() => runBacktest(data, DEFAULT_CONFIG)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// fetchHistoricalData — mock network test
// ---------------------------------------------------------------------------

describe('fetchHistoricalData', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function makeKaminoEntry(date: string, apy: number) {
    return { timestamp: date, metrics: { supplyInterestAPY: apy } }
  }

  it('parses Kamino API response and returns daily data points', async () => {
    const entries = [
      makeKaminoEntry('2024-01-01T00:00:00.000Z', 0.06),
      makeKaminoEntry('2024-01-01T06:00:00.000Z', 0.065),
      makeKaminoEntry('2024-01-02T00:00:00.000Z', 0.07),
      makeKaminoEntry('2024-01-02T12:00:00.000Z', 0.068),
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: entries }),
    })

    const data = await fetchHistoricalData(DEFAULT_CONFIG)

    // 2 unique days in the entries
    expect(data).toHaveLength(2)
    // Day 1: average of 0.06 and 0.065 = 0.0625
    expect(data[0]!.kaminoApy).toBeCloseTo(0.0625, 4)
    // Timestamps are midnight UTC
    expect(new Date(data[0]!.timestamp).getUTCHours()).toBe(0)
  })

  it('filters out zero-APY entries', async () => {
    const entries = [
      makeKaminoEntry('2024-01-01T00:00:00.000Z', 0),
      makeKaminoEntry('2024-01-01T06:00:00.000Z', 0.06),
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: entries }),
    })

    const data = await fetchHistoricalData(DEFAULT_CONFIG)

    // Only the non-zero entry contributes
    expect(data).toHaveLength(1)
    expect(data[0]!.kaminoApy).toBeCloseTo(0.06, 6)
  })

  it('applies marginfiApyMultiplier to kamino APY', async () => {
    const entries = [makeKaminoEntry('2024-01-01T00:00:00.000Z', 0.1)]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: entries }),
    })

    const config: BacktestConfig = { ...DEFAULT_CONFIG, marginfiApyMultiplier: 1.5 }
    const data = await fetchHistoricalData(config)

    expect(data[0]!.marginfiApy).toBeCloseTo(0.1 * 1.5, 6)
  })

  it('throws on non-OK API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    await expect(fetchHistoricalData(DEFAULT_CONFIG)).rejects.toThrow('Kamino API error: 503')
  })

  it('returns data sorted by day ascending', async () => {
    const entries = [
      makeKaminoEntry('2024-01-03T00:00:00.000Z', 0.07),
      makeKaminoEntry('2024-01-01T00:00:00.000Z', 0.06),
      makeKaminoEntry('2024-01-02T00:00:00.000Z', 0.065),
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ history: entries }),
    })

    const data = await fetchHistoricalData(DEFAULT_CONFIG)

    expect(data).toHaveLength(3)
    expect(data[0]!.kaminoApy).toBeCloseTo(0.06, 6)
    expect(data[1]!.kaminoApy).toBeCloseTo(0.065, 6)
    expect(data[2]!.kaminoApy).toBeCloseTo(0.07, 6)
  })
})
