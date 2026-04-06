import type { HistoricalDataPoint, BacktestConfig } from './types.js'

const KAMINO_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'
const KAMINO_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'

interface RawEntry { timestamp: string; metrics: { supplyInterestAPY: number } }
interface RawResponse { history: RawEntry[] }

export async function fetchHistoricalData(config: BacktestConfig): Promise<HistoricalDataPoint[]> {
  const url = `https://api.kamino.finance/kamino-market/${KAMINO_MARKET}/reserves/${KAMINO_RESERVE}/metrics/history`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Kamino API error: ${res.status}`)
  const raw = (await res.json()) as RawResponse
  const hourly = raw.history
    .filter(e => e.metrics.supplyInterestAPY > 0)
    .map(e => {
      const k = e.metrics.supplyInterestAPY
      const m = k * config.marginfiApyMultiplier
      const l = Math.max(k, m) * config.luloApyMultiplier
      return { timestamp: new Date(e.timestamp).getTime(), kaminoApy: k, marginfiApy: m, luloApy: l }
    })

  return aggregateToDaily(hourly)
}

/**
 * Aggregates sub-daily (e.g. hourly) data points into daily averages.
 * The Kamino API returns ~hourly observations; treating each as a daily
 * data point causes the engine to compound ~24x too often, inflating returns.
 */
function aggregateToDaily(points: HistoricalDataPoint[]): HistoricalDataPoint[] {
  const byDay = new Map<string, HistoricalDataPoint[]>()
  for (const p of points) {
    const day = new Date(p.timestamp).toISOString().split('T')[0]!
    const existing = byDay.get(day) ?? []
    existing.push(p)
    byDay.set(day, existing)
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayPoints]) => ({
      timestamp: new Date(day + 'T00:00:00.000Z').getTime(),
      kaminoApy: dayPoints.reduce((s, p) => s + p.kaminoApy, 0) / dayPoints.length,
      marginfiApy: dayPoints.reduce((s, p) => s + p.marginfiApy, 0) / dayPoints.length,
      luloApy: dayPoints.reduce((s, p) => s + p.luloApy, 0) / dayPoints.length,
    }))
}
