export interface MarketContext {
  vaultTvl: Record<string, number>        // risk level → TVL in USDC
  currentPositions: Array<{ name: string; allocation: number }>
  fundingRates: Record<string, number>    // asset → current funding rate
  lendingApy: number
  insuranceYield: number
  recentLiquidationVolume: number
  oracleDeviation: Record<string, number> // asset → deviation %
}

/**
 * Serialise a Record<string, number> into a readable bullet list.
 * e.g. { BTC: 0.003, SOL: -0.001 }  →  "  • BTC: 0.003\n  • SOL: -0.001"
 */
function formatRecord(rec: Record<string, number>, format?: (v: number) => string): string {
  const fmt = format ?? ((v) => String(v))
  const entries = Object.entries(rec)
  if (entries.length === 0) return '  (none)'
  return entries.map(([k, v]) => `  • ${k}: ${fmt(v)}`).join('\n')
}

/**
 * Build the context prompt sent to Claude for NanuqFi strategy decisions.
 * The output instructs Claude to respond ONLY with valid JSON — no markdown,
 * no prose — so that the response-validator can parse it deterministically.
 */
export function buildPrompt(context: MarketContext): string {
  const {
    vaultTvl,
    currentPositions,
    fundingRates,
    lendingApy,
    insuranceYield,
    recentLiquidationVolume,
    oracleDeviation,
  } = context

  const totalTvl = Object.values(vaultTvl).reduce((a, b) => a + b, 0)

  const tvlLines = formatRecord(vaultTvl, (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`)

  const positionLines =
    currentPositions.length > 0
      ? currentPositions
          .map((p) => `  • ${p.name}: ${p.allocation.toFixed(2)}%`)
          .join('\n')
      : '  (none)'

  const fundingLines = formatRecord(fundingRates, (v) => `${(v * 100).toFixed(4)}% per 8h`)

  const deviationLines = formatRecord(oracleDeviation, (v) => `${v.toFixed(4)}%`)

  const backendNames = Object.keys(fundingRates)
  const exampleWeights = backendNames.reduce<Record<string, number>>((acc, name, i) => {
    acc[name] = i === 0 ? 60 : Math.floor(40 / (backendNames.length - 1 || 1))
    return acc
  }, {})

  // Ensure example sums to 100 for illustration
  const exampleJson = JSON.stringify(
    {
      weights: backendNames.length > 0 ? exampleWeights : { 'drift-funding': 60, 'ranger-earn': 40 },
      confidence: 0.82,
      reasoning: 'Short explanation of your decision.',
    },
    null,
    2
  )

  return `You are NanuqFi's strategy advisor — an AI keeper for a Solana USDC yield-optimisation vault.

Your role is to recommend capital allocation weights across yield-generating backends based on current on-chain market conditions. You prioritise risk-adjusted returns and protect against liquidation risk.

═══════════════════════════════════════════════
CURRENT MARKET STATE  (timestamp: ${new Date().toISOString()})
═══════════════════════════════════════════════

VAULT TVL
  Total: $${totalTvl.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
${tvlLines}

CURRENT POSITIONS (active allocations)
${positionLines}

FUNDING RATES (Drift perpetuals)
${fundingLines}

LENDING APY
  ${(lendingApy * 100).toFixed(4)}% annualised

INSURANCE VAULT YIELD
  ${(insuranceYield * 100).toFixed(4)}% annualised

RECENT LIQUIDATION VOLUME
  $${recentLiquidationVolume.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC (last 24h)

ORACLE DEVIATIONS (from TWAP)
${deviationLines}

═══════════════════════════════════════════════
TASK
═══════════════════════════════════════════════

Analyse the above market state and recommend new allocation weights for all backends.

CONSTRAINTS:
  - Weights must be non-negative percentages (0-100)
  - All weights MUST sum to exactly 100
  - confidence must be a decimal between 0 and 1
  - reasoning must be a single concise sentence (max 200 chars)

RESPONSE FORMAT — respond ONLY with valid JSON, no markdown, no code fences, no prose:
${exampleJson}

Do not include any text outside the JSON object.`
}
