import { Connection, type Commitment } from '@solana/web3.js'
import {
  Wallet,
  loadKeypair,
  DriftClient,
  initialize,
  getMarketsAndOraclesForSubscription,
  type DriftClientConfig,
} from '@drift-labs/sdk'

export interface KeeperDriftConfig {
  rpcUrl: string
  rpcFallbackUrl?: string
  walletKeypairPath: string
  env: 'devnet' | 'mainnet-beta'
}

function buildClientConfig(
  connection: Connection,
  wallet: Wallet,
  env: 'devnet' | 'mainnet-beta',
  commitment: Commitment
): DriftClientConfig {
  const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
    getMarketsAndOraclesForSubscription(env)

  return {
    connection: connection as unknown as DriftClientConfig['connection'],
    wallet,
    env,
    opts: { commitment, preflightCommitment: commitment },
    accountSubscription: {
      type: 'websocket',
      commitment,
    },
    perpMarketIndexes,
    spotMarketIndexes,
    oracleInfos,
  }
}

export async function initDriftClient(config: KeeperDriftConfig): Promise<DriftClient> {
  const env = config.env
  const commitment: Commitment = 'confirmed'

  const keypair = loadKeypair(config.walletKeypairPath)
  const wallet = new Wallet(keypair)

  initialize({ env })

  let connection = new Connection(config.rpcUrl, { commitment })

  try {
    const client = new DriftClient(
      buildClientConfig(connection, wallet, env, commitment)
    )
    await client.subscribe()
    return client
  } catch (primaryError) {
    if (!config.rpcFallbackUrl) {
      throw primaryError
    }

    connection = new Connection(config.rpcFallbackUrl, { commitment })
    const client = new DriftClient(
      buildClientConfig(connection, wallet, env, commitment)
    )
    await client.subscribe()
    return client
  }
}

export function checkDriftHealth(client: DriftClient): boolean {
  return client.isSubscribed
}
