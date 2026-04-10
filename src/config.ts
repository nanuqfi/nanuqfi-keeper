export interface KeeperConfig {
  rpcUrls: string[]
  keeperKeypairPath: string
  cycleIntervalMs: number
  aiCycleIntervalMs: number
  aiApiKey: string
  aiBaseURL?: string
  aiModel: string
  aiMaxCallsPerHour: number
  aiBudgetPerDay: number
  alertTelegramToken?: string
  alertTelegramChatId?: string
  /** Lulo API key — required for live Lulo yield rates. Falls back to hardcoded rate if absent. */
  luloApiKey?: string
}

const MIN_CYCLE_INTERVAL_MS = 10_000 // 10 seconds — prevents tight polling loops

/**
 * Validate a KeeperConfig and throw with an actionable message on any invalid value.
 * Called at startup — fail fast rather than run with a broken config.
 */
export function validateConfig(config: KeeperConfig): void {
  const errors: string[] = []

  // cycleIntervalMs — must be finite positive number, minimum 10s
  if (!Number.isFinite(config.cycleIntervalMs) || config.cycleIntervalMs <= 0) {
    errors.push(
      `cycleIntervalMs must be a finite positive number, got ${config.cycleIntervalMs} ` +
      `(check CYCLE_INTERVAL_MS env var)`
    )
  } else if (config.cycleIntervalMs < MIN_CYCLE_INTERVAL_MS) {
    errors.push(
      `cycleIntervalMs must be ≥ ${MIN_CYCLE_INTERVAL_MS}ms (10s) to prevent tight loops, ` +
      `got ${config.cycleIntervalMs} (check CYCLE_INTERVAL_MS env var)`
    )
  }

  // aiCycleIntervalMs — must be finite positive number
  if (!Number.isFinite(config.aiCycleIntervalMs) || config.aiCycleIntervalMs <= 0) {
    errors.push(
      `aiCycleIntervalMs must be a finite positive number, got ${config.aiCycleIntervalMs} ` +
      `(check AI_CYCLE_INTERVAL_MS env var)`
    )
  }

  // rpcUrls — must be a non-empty array of non-empty strings
  if (!Array.isArray(config.rpcUrls) || config.rpcUrls.length === 0) {
    errors.push(
      `rpcUrls must be a non-empty array — set RPC_URL_PRIMARY or RPC_URL_FALLBACK env vars`
    )
  } else {
    for (const url of config.rpcUrls) {
      if (typeof url !== 'string' || url.trim().length === 0) {
        errors.push(`rpcUrls contains an empty or non-string entry: ${JSON.stringify(url)}`)
        break
      }
    }
  }

  // aiMaxCallsPerHour — must be a positive finite number when provided
  if (config.aiMaxCallsPerHour !== undefined) {
    if (!Number.isFinite(config.aiMaxCallsPerHour) || config.aiMaxCallsPerHour <= 0) {
      errors.push('AI_MAX_CALLS_PER_HOUR must be a positive number')
    }
  }

  // aiBudgetPerDay — must be a positive finite number when provided
  if (config.aiBudgetPerDay !== undefined) {
    if (!Number.isFinite(config.aiBudgetPerDay) || config.aiBudgetPerDay <= 0) {
      errors.push('AI_BUDGET_PER_DAY must be a positive number')
    }
  }

  // keeperKeypairPath — if provided (non-empty string), must actually be a string
  if (config.keeperKeypairPath !== '' && typeof config.keeperKeypairPath !== 'string') {
    errors.push(
      `keeperKeypairPath must be a non-empty string or left unset, ` +
      `got ${JSON.stringify(config.keeperKeypairPath)} (check KEEPER_KEYPAIR_PATH env var)`
    )
  }

  if (errors.length > 0) {
    throw new Error(
      `[Config] Invalid keeper configuration — fix before restarting:\n` +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    )
  }
}

export function loadConfig(): KeeperConfig {
  const config: KeeperConfig = {
    rpcUrls: [
      process.env.RPC_URL_PRIMARY ?? '',
      process.env.RPC_URL_FALLBACK ?? '',
      'https://api.devnet.solana.com',
    ].filter(Boolean),
    keeperKeypairPath: process.env.KEEPER_KEYPAIR_PATH ?? '',
    cycleIntervalMs: Number(process.env.CYCLE_INTERVAL_MS ?? 600_000),
    aiCycleIntervalMs: Number(process.env.AI_CYCLE_INTERVAL_MS ?? 7_200_000),
    aiApiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
    aiBaseURL: process.env.AI_BASE_URL,
    aiModel: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    aiMaxCallsPerHour: Number(process.env.AI_MAX_CALLS_PER_HOUR ?? 10),
    aiBudgetPerDay: Number(process.env.AI_BUDGET_PER_DAY ?? 5),
    alertTelegramToken: process.env.TELEGRAM_BOT_TOKEN,
    alertTelegramChatId: process.env.TELEGRAM_CHAT_ID,
    luloApiKey: process.env.LULO_API_KEY,
  }
  validateConfig(config)
  return config
}
