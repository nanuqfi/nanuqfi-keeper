const DAYS_PER_YEAR = 365
const SQRT_DAYS = Math.sqrt(DAYS_PER_YEAR)

export function computeCagr(start: number, end: number, days: number): number {
  if (days <= 0 || start <= 0) return 0
  return Math.pow(end / start, DAYS_PER_YEAR / days) - 1
}

export function computeMaxDrawdown(values: number[]): number {
  if (values.length < 2) return 0
  let peak = values[0]!
  let maxDd = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDd) maxDd = dd
  }
  return maxDd
}

export function computeVolatility(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * SQRT_DAYS
}

export function computeSharpe(ret: number, rf: number, vol: number): number {
  return vol === 0 ? 0 : (ret - rf) / vol
}

export function computeSortino(returns: number[], rf: number): number {
  if (returns.length < 2) return 0
  const dailyRf = rf / DAYS_PER_YEAR
  const downside = returns.map(r => r - dailyRf).filter(r => r < 0)
  if (downside.length === 0) return 0
  const dVar = downside.reduce((s, r) => s + r ** 2, 0) / downside.length
  const dDev = Math.sqrt(dVar) * SQRT_DAYS
  if (dDev === 0) return 0
  const annRet = returns.reduce((a, b) => a + b, 0) / returns.length * DAYS_PER_YEAR
  return (annRet - rf) / dDev
}
