// Multi-protocol DeFi yield scanner.
// READ-ONLY: scans yield opportunities across Solana DeFi — never executes trades.

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools'
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

  // DeFi Llama — aggregate yields across Solana
  try {
    const llamaYields = await fetchDeFiLlamaYields()
    opportunities.push(...llamaYields)
  } catch {
    // DeFi Llama down — continue
  }

  // Sort by APY descending
  opportunities.sort((a, b) => b.apy - a.apy)

  // Find best per risk tier
  const bestByRisk = {
    low: opportunities.find(o => o.risk === 'low') ?? null,
    medium: opportunities.find(o => o.risk === 'medium') ?? null,
    high: opportunities.find(o => o.risk === 'high') ?? null,
  }

  // driftComparison shape kept for API compatibility — always empty now
  const marketBestApy = opportunities.length > 0 ? opportunities[0]!.apy : 0

  return {
    timestamp: Date.now(),
    opportunities,
    bestByRisk,
    driftComparison: {
      driftBestApy: 0,
      marketBestApy,
      driftRank: opportunities.length + 1,
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
