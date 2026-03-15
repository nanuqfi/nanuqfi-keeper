// Drift Data API wrapper with TTL caching.
// Fetch functions are duplicated from @nanuqfi/backend-drift because
// that package isn't published to npm yet. These are thin HTTP calls —
// safe to inline until the monorepo package is available.

const DRIFT_DATA_API_URL = 'https://data.api.drift.trade'

const PRICE_PRECISION = 1e9
const ORACLE_PRECISION = 1e6
const HOURS_PER_YEAR = 24 * 365

// --- Drift Data API types and fetch functions ---

export interface RawFundingRate {
  slot: number
  fundingRate: string
  oraclePriceTwap: string
  markPriceTwap: string
  fundingRateLong: string
  fundingRateShort: string
}

export interface ParsedFundingRate {
  slot: number
  hourlyRate: number
  annualizedApr: number
  oraclePrice: number
}

interface FundingRateResponse {
  fundingRates: RawFundingRate[]
}

interface RateHistoryResponse {
  rates: { ts: number; rate: string }[]
}

export function parseFundingRate(raw: RawFundingRate): ParsedFundingRate {
  const fundingRate = Number(raw.fundingRate) / PRICE_PRECISION
  const oraclePrice = Number(raw.oraclePriceTwap) / ORACLE_PRECISION
  const hourlyRate = oraclePrice === 0 ? 0 : fundingRate / oraclePrice
  const annualizedApr = hourlyRate * HOURS_PER_YEAR * 100

  return {
    slot: raw.slot,
    hourlyRate,
    annualizedApr,
    oraclePrice,
  }
}

function parseDepositRate(rate: string): number {
  if (rate.trim() === '') return NaN
  return Number(rate)
}

export async function fetchFundingRates(
  marketName: string,
  baseUrl: string = DRIFT_DATA_API_URL,
): Promise<RawFundingRate[]> {
  const url = `${baseUrl}/fundingRates?marketName=${encodeURIComponent(marketName)}`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Drift Data API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as FundingRateResponse
  return data.fundingRates ?? []
}

export async function fetchDepositRate(
  marketIndex: number,
  baseUrl: string = DRIFT_DATA_API_URL,
): Promise<number> {
  const url = `${baseUrl}/rateHistory?marketIndex=${marketIndex}&type=deposit`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Drift Data API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as RateHistoryResponse
  const rates = data.rates ?? []

  if (rates.length === 0) {
    return 0
  }

  return parseDepositRate(rates[rates.length - 1]!.rate)
}

export async function fetchBorrowRate(
  marketIndex: number,
  baseUrl: string = DRIFT_DATA_API_URL,
): Promise<number> {
  const url = `${baseUrl}/rateHistory?marketIndex=${marketIndex}&type=borrow`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Drift Data API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as RateHistoryResponse
  const rates = data.rates ?? []

  if (rates.length === 0) {
    return 0
  }

  return parseDepositRate(rates[rates.length - 1]!.rate)
}

// --- Caching layer ---

interface CacheEntry<T> {
  data: T
  timestamp: number
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export class DriftDataCache {
  private cache = new Map<string, CacheEntry<unknown>>()
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs
  }

  private get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }
    return entry.data
  }

  private set<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  get size(): number {
    return this.cache.size
  }

  async getFundingRates(marketName: string): Promise<ParsedFundingRate[]> {
    const cacheKey = `funding:${marketName}`
    const cached = this.get<ParsedFundingRate[]>(cacheKey)
    if (cached) return cached
    const raw = await fetchFundingRates(marketName)
    const parsed = raw.map(parseFundingRate)
    this.set(cacheKey, parsed)
    return parsed
  }

  async getDepositRate(marketIndex: number): Promise<number> {
    const cacheKey = `deposit:${marketIndex}`
    const cached = this.get<number>(cacheKey)
    if (cached !== null) return cached
    const rate = await fetchDepositRate(marketIndex)
    this.set(cacheKey, rate)
    return rate
  }

  async getBorrowRate(marketIndex: number): Promise<number> {
    const cacheKey = `borrow:${marketIndex}`
    const cached = this.get<number>(cacheKey)
    if (cached !== null) return cached
    const rate = await fetchBorrowRate(marketIndex)
    this.set(cacheKey, rate)
    return rate
  }

  clear(): void {
    this.cache.clear()
  }
}
