export interface KeeperConfig {
  rpcUrls: string[]
  keeperKeypairPath: string
  cycleIntervalMs: number
  aiCycleIntervalMs: number
  aiApiKey: string
  aiModel: string
  aiMaxCallsPerHour: number
  aiBudgetPerDay: number
  alertTelegramToken?: string
  alertTelegramChatId?: string
}

export function loadConfig(): KeeperConfig {
  return {
    rpcUrls: [
      process.env.RPC_URL_PRIMARY ?? '',
      process.env.RPC_URL_FALLBACK ?? '',
      'https://api.devnet.solana.com',
    ].filter(Boolean),
    keeperKeypairPath: process.env.KEEPER_KEYPAIR_PATH ?? '',
    cycleIntervalMs: Number(process.env.CYCLE_INTERVAL_MS ?? 600_000),
    aiCycleIntervalMs: Number(process.env.AI_CYCLE_INTERVAL_MS ?? 7_200_000),
    aiApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    aiModel: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    aiMaxCallsPerHour: Number(process.env.AI_MAX_CALLS_PER_HOUR ?? 10),
    aiBudgetPerDay: Number(process.env.AI_BUDGET_PER_DAY ?? 5),
    alertTelegramToken: process.env.TELEGRAM_BOT_TOKEN,
    alertTelegramChatId: process.env.TELEGRAM_CHAT_ID,
  }
}
