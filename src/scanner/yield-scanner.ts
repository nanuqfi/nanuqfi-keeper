// Multi-protocol DeFi yield scanner.
// READ-ONLY: scans yield opportunities across Solana DeFi — never executes trades.

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools'
const DRIFT_DATA_API_URL = 'https://data.api.drift.trade'
const FETCH_TIMEOUT_MS = 5_000

export interface YieldOpportunity {
  protocol: string
  strategy: string
  asset: string
  apy: number
  tvl: number
  risk: 'low' | 'medium' | 'high'
  source: string
}

export interface MarketScan {
  timestamp: number
  opportunities: YieldOpportunity[]
  bestByRisk: {
    low: YieldOpportunity | null
    medium: YieldOpportunity | null
    high: YieldOpportunity | null
  }
  driftComparison: {
    driftBestApy: number
    marketBestApy: number
    driftRank: number
    totalScanned: number
  }
}

export async function scanDeFiYields(): Promise<MarketScan> {
  const opportunities: YieldOpportunity[] = []

  // 1. DeFi Llama — aggregate yields across Solana
  try {
    const llamaYields = await fetchDeFiLlamaYields()
    opportunities.push(...llamaYields)
  } catch {
    // DeFi Llama down — continue with other sources
  }

  // 2. Drift rates (our execution layer)
  try {
    const driftYields = await fetchDriftYields()
    opportunities.push(...driftYields)
  } catch {
    // Drift API down — continue with what we have
  }

  // 3. Sort by APY descending
  opportunities.sort((a, b) => b.apy - a.apy)

  // 4. Find best per risk tier
  const bestByRisk = {
    low: opportunities.find(o => o.risk === 'low') ?? null,
    medium: opportunities.find(o => o.risk === 'medium') ?? null,
    high: opportunities.find(o => o.risk === 'high') ?? null,
  }

  // 5. Compare Drift vs market
  const driftOpps = opportunities.filter(o => o.protocol === 'Drift')
  const driftBestApy = driftOpps.length > 0 ? Math.max(...driftOpps.map(o => o.apy)) : 0
  const marketBestApy = opportunities.length > 0 ? opportunities[0]!.apy : 0
  const driftRank = opportunities.findIndex(o => o.protocol === 'Drift') + 1

  return {
    timestamp: Date.now(),
    opportunities,
    bestByRisk,
    driftComparison: {
      driftBestApy,
      marketBestApy,
      driftRank: driftRank || opportunities.length + 1,
      totalScanned: opportunities.length,
    },
  }
}

// ---------------------------------------------------------------------------
// DeFi Llama
// ---------------------------------------------------------------------------

interface DeFiLlamaPool {
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apy: number
  stablecoin: boolean
  ilRisk: string
}

interface DeFiLlamaResponse {
  status: string
  data: DeFiLlamaPool[]
}

export async function fetchDeFiLlamaYields(): Promise<YieldOpportunity[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(DEFILLAMA_YIELDS_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`DeFi Llama error: ${res.status}`)
    const data = (await res.json()) as DeFiLlamaResponse

    return (data.data ?? [])
      .filter((pool) =>
        pool.chain === 'Solana' &&
        pool.stablecoin === true &&
        pool.tvlUsd > 100_000 &&
        pool.apy > 0
      )
      .map((pool) => ({
        protocol: pool.project,
        strategy: pool.symbol,
        asset: pool.symbol.split('-')[0] ?? 'USDC',
        apy: pool.apy / 100,
        tvl: pool.tvlUsd,
        risk: classifyRisk(pool),
        source: 'defillama' as const,
      }))
      .slice(0, 50)
  } finally {
    clearTimeout(timeout)
  }
}

function classifyRisk(pool: DeFiLlamaPool): 'low' | 'medium' | 'high' {
  if (pool.ilRisk === 'no') return 'low'
  if (pool.apy > 20) return 'high'
  return 'medium'
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

interface DriftRateEntry {
  ts: number
  rate: string
}

interface DriftRateHistoryResponse {
  rates: DriftRateEntry[]
}

interface DriftFundingRateEntry {
  fundingRate: string
  oraclePriceTwap: string
}

interface DriftFundingRatesResponse {
  fundingRates: DriftFundingRateEntry[]
}

export async function fetchDriftYields(): Promise<YieldOpportunity[]> {
  const opportunities: YieldOpportunity[] = []

  // USDC lending rate
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(
        `${DRIFT_DATA_API_URL}/rateHistory?marketIndex=0&type=deposit`,
        { signal: controller.signal },
      )
      if (res.ok) {
        const data = (await res.json()) as DriftRateHistoryResponse
        const rates = data.rates ?? []
        if (rates.length > 0) {
          const latestRate = parseFloat(rates[rates.length - 1]!.rate)
          if (!isNaN(latestRate) && latestRate > 0) {
            opportunities.push({
              protocol: 'Drift',
              strategy: 'USDC Lending',
              asset: 'USDC',
              apy: latestRate,
              tvl: 0,
              risk: 'low',
              source: 'drift',
            })
          }
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // Drift deposit rate unavailable
  }

  // SOL-PERP basis trade yield
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(
        `${DRIFT_DATA_API_URL}/fundingRates?marketName=SOL-PERP`,
        { signal: controller.signal },
      )
      if (res.ok) {
        const data = (await res.json()) as DriftFundingRatesResponse
        const rates = data.fundingRates ?? []
        if (rates.length > 0) {
          const latest = rates[rates.length - 1]!
          const fundingRate = parseFloat(latest.fundingRate) / 1e9
          const oraclePrice = parseFloat(latest.oraclePriceTwap) / 1e6
          const hourlyRate = oraclePrice === 0 ? 0 : fundingRate / oraclePrice
          const apr = hourlyRate * 24 * 365
          if (apr > 0) {
            opportunities.push({
              protocol: 'Drift',
              strategy: 'SOL-PERP Basis Trade',
              asset: 'USDC',
              apy: apr,
              tvl: 0,
              risk: 'medium',
              source: 'drift',
            })
          }
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // Drift funding rate unavailable
  }

  return opportunities
}
