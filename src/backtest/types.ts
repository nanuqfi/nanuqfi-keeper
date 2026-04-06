export interface BacktestConfig {
  riskFreeRate: number
  marginfiApyMultiplier: number
  luloApyMultiplier: number
  initialDeposit: number
}

export const DEFAULT_CONFIG: BacktestConfig = {
  riskFreeRate: 0.04,
  marginfiApyMultiplier: 1.08,
  luloApyMultiplier: 1.05,
  initialDeposit: 10000,
}

export interface HistoricalDataPoint {
  timestamp: number
  kaminoApy: number
  marginfiApy: number
  luloApy: number
}

export interface BacktestDataPoint {
  timestamp: number
  portfolioValue: number
  kaminoValue: number
  marginfiValue: number
  luloValue: number
}

export interface ProtocolMetrics {
  totalReturn: number
  cagr: number
  maxDrawdown: number
  sharpeRatio: number
}

export interface BacktestResult {
  totalReturn: number
  cagr: number
  maxDrawdown: number
  sharpeRatio: number
  sortinoRatio: number
  volatility: number
  protocols: Record<string, ProtocolMetrics>
  series: BacktestDataPoint[]
  startDate: string
  endDate: string
  dataPoints: number
  riskFreeRate: number
}
