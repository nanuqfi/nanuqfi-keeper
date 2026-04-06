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
  return raw.history
    .filter(e => e.metrics.supplyInterestAPY > 0)
    .map(e => {
      const k = e.metrics.supplyInterestAPY
      const m = k * config.marginfiApyMultiplier
      const l = Math.max(k, m) * config.luloApyMultiplier
      return { timestamp: new Date(e.timestamp).getTime(), kaminoApy: k, marginfiApy: m, luloApy: l }
    })
}
