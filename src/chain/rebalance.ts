import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'

export const PROGRAM_ID = new PublicKey('2QtJ5kmxLuW2jYCFpJMtzZ7PCnKdoMwkeueYoDUi5z5P')
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? 'BiTXT15XyfSakk5Yz8L8QrzHPWbK8NjoZeEMFrDvKdKh',
)

// Canonical backend ordering — must match on-chain strategy slot indices
const DEFAULT_BACKEND_ORDER = [
  'kamino-lending',
  'marginfi-lending',
  'lulo-lending',
]

// ─── PDA Derivation ──────────────────────────────────────────────────────

export function deriveAllocatorPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('allocator')],
    PROGRAM_ID,
  )
}

export function deriveRiskVaultPda(
  allocator: PublicKey,
  riskLevelIndex: number,
): [PublicKey, number] {
  const riskBuf = Buffer.alloc(1)
  riskBuf.writeUInt8(riskLevelIndex)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('risk_vault'), allocator.toBuffer(), riskBuf],
    PROGRAM_ID,
  )
}

export function deriveRebalanceRecordPda(
  riskVault: PublicKey,
  counter: number,
): [PublicKey, number] {
  const counterBuf = Buffer.alloc(4)
  counterBuf.writeUInt32LE(counter)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rebalance'), riskVault.toBuffer(), counterBuf],
    PROGRAM_ID,
  )
}

export function deriveTreasuryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('treasury')],
    PROGRAM_ID,
  )
}

// ─── Utilities ───────────────────────────────────────────────────────────

/**
 * Convert keeper weight map (Record<string, number> in bps) to ordered u16 array.
 * Missing backends get 0. Values are clamped to u16 max (65535).
 */
export function weightsToU16Array(
  weights: Record<string, number>,
  backendOrder: string[] = DEFAULT_BACKEND_ORDER,
): number[] {
  return backendOrder.map(name => {
    const val = weights[name] ?? 0
    return Math.min(Math.max(Math.round(val), 0), 65535)
  })
}

/**
 * SHA-256 hash of AI reasoning string → 32-byte Uint8Array.
 * Stored on-chain for transparency / auditability.
 */
export function hashReasoning(reasoning: string): Uint8Array {
  const hash = createHash('sha256').update(reasoning, 'utf-8').digest()
  return new Uint8Array(hash)
}

/** Map risk level string to on-chain RiskLevel enum index. */
export function riskLevelToIndex(level: string): number {
  const map: Record<string, number> = {
    conservative: 0,
    moderate: 1,
    aggressive: 2,
  }
  const idx = map[level]
  if (idx === undefined) {
    throw new Error(`Unknown risk level: ${level}`)
  }
  return idx
}

// ─── Rebalance Submission ────────────────────────────────────────────────

export interface RebalanceParams {
  rpcUrl: string
  keypairPath: string
  riskLevel: string
  weights: Record<string, number>
  reasoning: string
  rebalanceCounter: number
  equitySnapshot: bigint
  vaultUsdcAddress: PublicKey
  treasuryUsdcAddress: PublicKey
}

export interface RebalanceResult {
  success: boolean
  txSignature?: string
  error?: string
}

/**
 * Build and submit a rebalance transaction to the on-chain allocator program.
 *
 * Uses raw instruction building (not IDL-generated client) to avoid
 * importing the full IDL at runtime. Discriminator is from the IDL:
 * rebalance = [108, 158, 77, 9, 210, 52, 88, 62]
 */
export async function submitRebalance(params: RebalanceParams): Promise<RebalanceResult> {
  try {
    const keypairData = JSON.parse(readFileSync(params.keypairPath, 'utf-8'))
    const keeper = Keypair.fromSecretKey(new Uint8Array(keypairData))
    const connection = new Connection(params.rpcUrl, 'confirmed')

    const riskIdx = riskLevelToIndex(params.riskLevel)
    const [allocatorPda] = deriveAllocatorPda()
    const [riskVaultPda] = deriveRiskVaultPda(allocatorPda, riskIdx)
    const [rebalanceRecordPda] = deriveRebalanceRecordPda(riskVaultPda, params.rebalanceCounter)
    const [treasuryPda] = deriveTreasuryPda()

    const newWeights = weightsToU16Array(params.weights)
    const aiReasoningHash = hashReasoning(params.reasoning)

    // Build instruction data:
    // [8-byte discriminator] [borsh-encoded args: Vec<u16>, u64, bytes]
    const discriminator = Buffer.from([108, 158, 77, 9, 210, 52, 88, 62])

    // Encode new_weights: Vec<u16> = [4-byte len (LE)] + [2-byte per element (LE)]
    const weightsLen = Buffer.alloc(4)
    weightsLen.writeUInt32LE(newWeights.length)
    const weightsData = Buffer.alloc(newWeights.length * 2)
    newWeights.forEach((w, i) => weightsData.writeUInt16LE(w, i * 2))

    // Encode equity_snapshot: u64 (8 bytes LE)
    const equityBuf = Buffer.alloc(8)
    equityBuf.writeBigUInt64LE(params.equitySnapshot)

    // Encode ai_reasoning_hash: bytes = [4-byte len (LE)] + [data]
    const hashLen = Buffer.alloc(4)
    hashLen.writeUInt32LE(aiReasoningHash.length)
    const hashData = Buffer.from(aiReasoningHash)

    const data = Buffer.concat([
      discriminator,
      weightsLen,
      weightsData,
      equityBuf,
      hashLen,
      hashData,
    ])

    const keys = [
      { pubkey: allocatorPda, isSigner: false, isWritable: true },
      { pubkey: riskVaultPda, isSigner: false, isWritable: true },
      { pubkey: rebalanceRecordPda, isSigner: false, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: params.vaultUsdcAddress, isSigner: false, isWritable: true },
      { pubkey: params.treasuryUsdcAddress, isSigner: false, isWritable: true },
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]

    const ix = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data,
    })

    const tx = new Transaction().add(ix)
    const signature = await sendAndConfirmTransaction(connection, tx, [keeper], {
      commitment: 'confirmed',
      maxRetries: 3,
    })

    return { success: true, txSignature: signature }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}
