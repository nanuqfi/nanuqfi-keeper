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
      weights: backendNames.length > 0 ? exampleWeights : { 'kamino-lending': 60, 'marginfi-lending': 40 },
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

LENDING RATES
${fundingLines.replace('(none)', 'No external rate feeds')}

KAMINO SUPPLY APY
  ${(lendingApy * 100).toFixed(4)}% annualised

MARGINFI LENDING APY
  ${(insuranceYield * 100).toFixed(4)}% annualised

RECENT LIQUIDATION VOLUME
  $${recentLiquidationVolume.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC (last 24h)

ORACLE DEVIATIONS (from TWAP)
${deviationLines}

═══════════════════════════════════════════════
TASK
═══════════════════════════════════════════════

Analyse the above market state and recommend new allocation weights for all lending backends.

CONSTRAINTS:
  - Weights must be non-negative percentages (0-100)
  - All weights MUST sum to exactly 100
  - confidence must be a decimal between 0 and 1
  - reasoning must be a single concise sentence (max 200 chars)

RESPONSE FORMAT — respond ONLY with valid JSON, no markdown, no code fences, no prose:
${exampleJson}

Do not include any text outside the JSON object.`
}

/**
 * Build a prompt that asks Claude for per-strategy confidence scores
 * and a risk_elevated flag — used in blended scoring mode.
 */
export function buildInsightPrompt(
  context: MarketContext,
  strategyNames: string[],
): string {
  const {
    vaultTvl,
    currentPositions,
    fundingRates,
    lendingApy,
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

  const exampleStrategies: Record<string, number> = {}
  for (const name of strategyNames) {
    exampleStrategies[name] = 0.8
  }

  const exampleJson = JSON.stringify(
    {
      strategies: exampleStrategies,
      risk_elevated: false,
      regime: 'range',
      reasoning: 'Short explanation of sustainability assessment.',
    },
    null,
    2,
  )

  return `You are NanuqFi's strategy advisor — an AI keeper for a Solana USDC yield-optimisation vault.

Your role is to evaluate the SUSTAINABILITY of each yield strategy based on current market conditions, and flag regime-level risks.

═══════════════════════════════════════════════
CURRENT MARKET STATE  (timestamp: ${new Date().toISOString()})
═══════════════════════════════════════════════

VAULT TVL
  Total: $${totalTvl.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
${tvlLines}

CURRENT POSITIONS (active allocations)
${positionLines}

LENDING RATES
${fundingLines.replace('(none)', 'No external rate feeds')}

KAMINO SUPPLY APY
  ${(lendingApy * 100).toFixed(4)}% annualised

RECENT LIQUIDATION VOLUME
  $${recentLiquidationVolume.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC (last 24h)

ORACLE DEVIATIONS (from TWAP)
${deviationLines}

═══════════════════════════════════════════════
TASK
═══════════════════════════════════════════════

For each lending strategy below, rate your confidence (0.0 to 1.0) that it will sustain its current yield over the next 2-4 hours:

Strategies to evaluate: ${strategyNames.join(', ')}

CONFIDENCE SCALE:
  1.0 = fully confident yield is sustainable
  0.5 = uncertain, expect yield to decline
  0.0 = yield unsustainable or dangerous, should exit

Also assess:
1. Whether there is a REGIME-LEVEL RISK (high liquidation volume, extreme oracle deviation, or protocol instability) that should reduce exposure.
2. The current MARKET REGIME — classify as one of:
   - "trend": directional momentum detected (lending rates may shift)
   - "range": sideways/stable conditions (lending rates stable, favored)
   - "stress": high volatility, liquidation cascades, or protocol risk (de-risk)

RESPONSE FORMAT — respond ONLY with valid JSON, no markdown, no code fences, no prose:
${exampleJson}

Do not include any text outside the JSON object.`
}
