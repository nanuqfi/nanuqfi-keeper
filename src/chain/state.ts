import { Connection, PublicKey } from '@solana/web3.js'
import {
  deriveAllocatorPda,
  deriveRiskVaultPda,
  deriveTreasuryPda,
  riskLevelToIndex,
} from './rebalance.js'

const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

// Devnet test USDC mint (we are the mint authority, NOT Circle's devnet USDC).
// Matches the USDC_MINT constant in rebalance.ts — must stay in sync.
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? 'BiTXT15XyfSakk5Yz8L8QrzHPWbK8NjoZeEMFrDvKdKh',
)

// ─── Byte Offsets ─────────────────────────────────────────────────────────────
//
// All offsets include the 8-byte Anchor account discriminator.
//
// RiskVault field layout:
//   disc(8) | version(1) | allocator(32) | risk_level(1) |
//   protocol_vault(32) | share_mint(32) |
//   total_shares(8) | total_assets(8) |
//   peak_equity(8) | current_equity(8) | equity_24h_ago(8) |
//   last_rebalance_slot(8) | rebalance_counter(4)
//
// Sum: 8+1+32+1+32+32+8+8+8+8+8+8 = 154
const RISK_VAULT_REBALANCE_COUNTER_OFFSET = 154

// Treasury field layout:
//   disc(8) | version(1) | allocator(32) | usdc_token_account(32)
//
// Sum: 8+1+32 = 41
const TREASURY_USDC_ACCOUNT_OFFSET = 41

// ─── ATA Derivation ───────────────────────────────────────────────────────────

/**
 * Derive the Associated Token Account (ATA) address for a given mint + owner.
 * Deterministic — no on-chain lookup required.
 */
export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )
  return ata
}

// ─── Chain State ──────────────────────────────────────────────────────────────

export interface RebalanceChainState {
  /** Per-vault counter stored in RiskVault — used as PDA seed for RebalanceRecord. */
  rebalanceCounter: number
  /** Allocator's USDC ATA — where vault USDC balance lives. */
  vaultUsdcAddress: PublicKey
  /** Treasury USDC token account stored in Treasury account data. */
  treasuryUsdcAddress: PublicKey
  /** Current USDC balance of the vault ATA in raw lamports (u64). */
  equitySnapshot: bigint
}

/**
 * Fetch the on-chain state required to build a valid rebalance instruction.
 *
 * Fetches RiskVault + Treasury accounts in parallel to minimise latency,
 * then reads the vault USDC balance.
 *
 * Throws on any missing account — callers must not submit a rebalance with
 * stale / guessed values. Better to fail loudly than silently use wrong PDAs.
 */
export async function fetchRebalanceChainState(
  rpcUrl: string,
  riskLevel: string,
): Promise<RebalanceChainState> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const riskIdx = riskLevelToIndex(riskLevel) // throws on unknown level

  const [allocatorPda] = deriveAllocatorPda()
  const [riskVaultPda] = deriveRiskVaultPda(allocatorPda, riskIdx)
  const [treasuryPda] = deriveTreasuryPda()

  const [riskVaultInfo, treasuryInfo] = await Promise.all([
    connection.getAccountInfo(riskVaultPda),
    connection.getAccountInfo(treasuryPda),
  ])

  if (!riskVaultInfo?.data) {
    throw new Error(
      `RiskVault account not found for ${riskLevel} (PDA: ${riskVaultPda.toBase58()})`,
    )
  }
  if (!treasuryInfo?.data) {
    throw new Error(`Treasury account not found (PDA: ${treasuryPda.toBase58()})`)
  }

  // rebalance_counter: u32 at offset 154 (LE)
  const rebalanceCounter = riskVaultInfo.data.readUInt32LE(RISK_VAULT_REBALANCE_COUNTER_OFFSET)

  // usdc_token_account: Pubkey (32 bytes) at offset 41
  const treasuryUsdcAddress = new PublicKey(
    riskVaultInfo.data.length > 0
      ? treasuryInfo.data.subarray(TREASURY_USDC_ACCOUNT_OFFSET, TREASURY_USDC_ACCOUNT_OFFSET + 32)
      : Buffer.alloc(32),
  )

  // Vault USDC ATA: deterministic from allocator PDA + USDC mint
  const vaultUsdcAddress = getAssociatedTokenAddress(USDC_MINT, allocatorPda)

  // Read actual USDC balance — this is the equity_snapshot for the rebalance ix
  const balance = await connection.getTokenAccountBalance(vaultUsdcAddress)
  const equitySnapshot = BigInt(balance.value.amount)

  return { rebalanceCounter, vaultUsdcAddress, treasuryUsdcAddress, equitySnapshot }
}
