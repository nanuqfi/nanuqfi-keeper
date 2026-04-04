export interface DriftConfig {
  rpcUrl: string
  rpcFallbackUrl?: string
  walletKeypairPath: string
  env: 'devnet' | 'mainnet-beta'
}

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
  drift?: DriftConfig
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
    aiApiKey: process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
    aiBaseURL: process.env.AI_BASE_URL,
    aiModel: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
    aiMaxCallsPerHour: Number(process.env.AI_MAX_CALLS_PER_HOUR ?? 10),
    aiBudgetPerDay: Number(process.env.AI_BUDGET_PER_DAY ?? 5),
    alertTelegramToken: process.env.TELEGRAM_BOT_TOKEN,
    alertTelegramChatId: process.env.TELEGRAM_CHAT_ID,
    drift: buildDriftConfig(),
  }
}

function buildDriftConfig(): DriftConfig | undefined {
  const rpcUrl = process.env.DRIFT_RPC_URL ?? process.env.RPC_URL_PRIMARY
  const walletPath = process.env.KEEPER_WALLET_PATH ?? process.env.KEEPER_KEYPAIR_PATH

  // Drift config is optional — without RPC URL or wallet, keeper runs in mock mode
  if (!rpcUrl || !walletPath) return undefined

  return {
    rpcUrl,
    rpcFallbackUrl: process.env.DRIFT_RPC_FALLBACK ?? process.env.RPC_URL_FALLBACK,
    walletKeypairPath: walletPath,
    env: (process.env.DRIFT_ENV as 'devnet' | 'mainnet-beta') ?? 'devnet',
  }
}
