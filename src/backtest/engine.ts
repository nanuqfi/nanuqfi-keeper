import type { HistoricalDataPoint, BacktestConfig, BacktestResult, BacktestDataPoint, ProtocolMetrics } from './types.js'
import { computeCagr, computeMaxDrawdown, computeVolatility, computeSharpe, computeSortino } from './metrics.js'

const DAYS_PER_YEAR = 365

const VOL_WEIGHTS: Record<string, number> = {
  'kamino-lending': 1.0,
  'marginfi-lending': 0.95,
  'lulo-lending': 0.90,
}

function computeWeights(k: number, m: number, l: number): Record<string, number> {
  const scores = {
    'kamino-lending': k * VOL_WEIGHTS['kamino-lending']!,
    'marginfi-lending': m * VOL_WEIGHTS['marginfi-lending']!,
    'lulo-lending': l * VOL_WEIGHTS['lulo-lending']!,
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0)
  if (total === 0) return { 'kamino-lending': 1 / 3, 'marginfi-lending': 1 / 3, 'lulo-lending': 1 / 3 }
  const w: Record<string, number> = {}
  for (const [key, s] of Object.entries(scores)) w[key] = s / total
  return w
}

export function runBacktest(data: HistoricalDataPoint[], config: BacktestConfig): BacktestResult {
  const init = config.initialDeposit
  let pv = init, kv = init, mv = init, lv = init
  const series: BacktestDataPoint[] = []
  const pvs: number[] = []
  const rets: number[] = []

  for (let i = 0; i < data.length; i++) {
    const d = data[i]!
    if (i === 0) {
      series.push({ timestamp: d.timestamp, portfolioValue: init, kaminoValue: init, marginfiValue: init, luloValue: init })
      pvs.push(init)
      continue
    }
    const w = computeWeights(d.kaminoApy, d.marginfiApy, d.luloApy)
    const dr = (w['kamino-lending']! * d.kaminoApy + w['marginfi-lending']! * d.marginfiApy + w['lulo-lending']! * d.luloApy) / DAYS_PER_YEAR
    const prev = pv
    pv *= 1 + dr
    kv *= 1 + d.kaminoApy / DAYS_PER_YEAR
    mv *= 1 + d.marginfiApy / DAYS_PER_YEAR
    lv *= 1 + d.luloApy / DAYS_PER_YEAR
    series.push({ timestamp: d.timestamp, portfolioValue: pv, kaminoValue: kv, marginfiValue: mv, luloValue: lv })
    pvs.push(pv)
    rets.push((pv - prev) / prev)
  }

  const last = series[series.length - 1]!
  const days = data.length
  const tr = (last.portfolioValue - init) / init
  const cagr = computeCagr(init, last.portfolioValue, days)
  const md = computeMaxDrawdown(pvs)
  const vol = computeVolatility(rets)
  const sr = computeSharpe(cagr, config.riskFreeRate, vol)
  const so = computeSortino(rets, config.riskFreeRate)

  function pm(ev: number, r: number[], v: number[]): ProtocolMetrics {
    const t = (ev - init) / init
    const c = computeCagr(init, ev, days)
    const d = computeMaxDrawdown(v)
    const vl = computeVolatility(r)
    return { totalReturn: t, cagr: c, maxDrawdown: d, sharpeRatio: computeSharpe(c, config.riskFreeRate, vl) }
  }

  const kr = series.slice(1).map((p, i) => (p.kaminoValue - series[i]!.kaminoValue) / series[i]!.kaminoValue)
  const mr = series.slice(1).map((p, i) => (p.marginfiValue - series[i]!.marginfiValue) / series[i]!.marginfiValue)
  const lr = series.slice(1).map((p, i) => (p.luloValue - series[i]!.luloValue) / series[i]!.luloValue)

  return {
    totalReturn: tr,
    cagr,
    maxDrawdown: md,
    sharpeRatio: sr,
    sortinoRatio: so,
    volatility: vol,
    protocols: {
      'kamino-lending': pm(last.kaminoValue, kr, series.map(s => s.kaminoValue)),
      'marginfi-lending': pm(last.marginfiValue, mr, series.map(s => s.marginfiValue)),
      'lulo-lending': pm(last.luloValue, lr, series.map(s => s.luloValue)),
    },
    series,
    startDate: new Date(data[0]!.timestamp).toISOString().split('T')[0]!,
    endDate: new Date(data[data.length - 1]!.timestamp).toISOString().split('T')[0]!,
    dataPoints: data.length,
    riskFreeRate: config.riskFreeRate,
  }
}
