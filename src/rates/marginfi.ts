/**
 * Marginfi USDC lending rate fetcher.
 *
 * Uses DeFi Llama's yields API to fetch the live Marginfi USDC pool APY on
 * Solana. Falls back to MARGINFI_FALLBACK_RATE on any failure — the keeper
 * must never block on rate data.
 *
 * DeFi Llama returns APY as a percentage (e.g., 7.5 = 7.5%). We convert
 * to decimal before returning (0.075).
 */

export const MARGINFI_FALLBACK_RATE = 0.065

const DEFI_LLAMA_POOLS_URL = 'https://yields.llama.fi/pools'
const TIMEOUT_MS = 10_000

interface DefiLlamaPool {
  project: string
  symbol: string
  chain: string
  apy: number
}

interface DefiLlamaResponse {
  data?: DefiLlamaPool[]
}

export async function fetchMarginfiRate(): Promise<number> {
  try {
    const res = await fetch(DEFI_LLAMA_POOLS_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      console.warn(`[Marginfi] DeFi Llama API returned ${res.status}, using fallback`)
      return MARGINFI_FALLBACK_RATE
    }

    const data = await res.json() as DefiLlamaResponse

    const pool = data.data?.find(
      (p) => p.project === 'marginfi' && p.symbol === 'USDC' && p.chain === 'Solana',
    )

    if (!pool || typeof pool.apy !== 'number') {
      console.warn('[Marginfi] USDC pool not found on DeFi Llama, using fallback')
      return MARGINFI_FALLBACK_RATE
    }

    const rate = pool.apy / 100
    console.log(`[Marginfi] Live rate: ${(rate * 100).toFixed(2)}%`)
    return rate
  } catch (err) {
    console.warn(
      `[Marginfi] Rate fetch failed: ${err instanceof Error ? err.message : err}, using fallback`,
    )
    return MARGINFI_FALLBACK_RATE
  }
}
