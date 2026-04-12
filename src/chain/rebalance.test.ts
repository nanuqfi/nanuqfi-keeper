import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PublicKey, Keypair } from '@solana/web3.js'
import {
  deriveAllocatorPda,
  deriveRiskVaultPda,
  deriveRebalanceRecordPda,
  deriveTreasuryPda,
  weightsToU16Array,
  hashReasoning,
  riskLevelToIndex,
  submitRebalance,
  PROGRAM_ID,
} from './rebalance.js'

describe('PDA derivation', () => {
  it('derives allocator PDA deterministically', () => {
    const [pda, bump] = deriveAllocatorPda()
    expect(pda).toBeInstanceOf(PublicKey)
    expect(bump).toBeGreaterThanOrEqual(0)
    expect(bump).toBeLessThanOrEqual(255)

    // Same call should return same PDA
    const [pda2] = deriveAllocatorPda()
    expect(pda.toBase58()).toBe(pda2.toBase58())
  })

  it('derives risk vault PDA from allocator + risk level', () => {
    const [allocator] = deriveAllocatorPda()

    const [moderate] = deriveRiskVaultPda(allocator, 1)
    const [aggressive] = deriveRiskVaultPda(allocator, 2)

    expect(moderate).toBeInstanceOf(PublicKey)
    expect(aggressive).toBeInstanceOf(PublicKey)
    // Different risk levels → different PDAs
    expect(moderate.toBase58()).not.toBe(aggressive.toBase58())
  })

  it('derives rebalance record PDA from vault + counter', () => {
    const [allocator] = deriveAllocatorPda()
    const [vault] = deriveRiskVaultPda(allocator, 1)

    const [rec0] = deriveRebalanceRecordPda(vault, 0)
    const [rec1] = deriveRebalanceRecordPda(vault, 1)

    expect(rec0).toBeInstanceOf(PublicKey)
    expect(rec1).toBeInstanceOf(PublicKey)
    // Different counters → different PDAs
    expect(rec0.toBase58()).not.toBe(rec1.toBase58())
  })

  it('derives treasury PDA', () => {
    const [pda] = deriveTreasuryPda()
    expect(pda).toBeInstanceOf(PublicKey)
  })

  it('uses correct program ID', () => {
    expect(PROGRAM_ID.toBase58()).toBe('2QtJ5kmxLuW2jYCFpJMtzZ7PCnKdoMwkeueYoDUi5z5P')
  })
})

describe('weightsToU16Array', () => {
  it('converts weight map to ordered u16 array', () => {
    const weights: Record<string, number> = {
      'kamino-lending': 6000,
      'marginfi-lending': 4000,
    }
    const backendOrder = ['kamino-lending', 'marginfi-lending']
    const result = weightsToU16Array(weights, backendOrder)

    expect(result).toEqual([6000, 4000])
  })

  it('fills missing backends with 0', () => {
    const weights: Record<string, number> = {
      'kamino-lending': 10000,
    }
    const backendOrder = ['kamino-lending', 'marginfi-lending']
    const result = weightsToU16Array(weights, backendOrder)

    expect(result).toEqual([10000, 0])
  })

  it('handles all-zero weights', () => {
    const result = weightsToU16Array({}, ['kamino-lending', 'marginfi-lending'])
    expect(result).toEqual([0, 0])
  })

  it('clamps values to u16 range', () => {
    const weights = { 'a': 70000 }
    const result = weightsToU16Array(weights, ['a'])
    expect(result[0]).toBeLessThanOrEqual(65535)
  })
})

describe('hashReasoning', () => {
  it('returns 32-byte Uint8Array for non-empty string', () => {
    const hash = hashReasoning('Test reasoning for rebalance decision')
    expect(hash).toBeInstanceOf(Uint8Array)
    expect(hash.length).toBe(32)
  })

  it('returns consistent hash for same input', () => {
    const a = hashReasoning('same input')
    const b = hashReasoning('same input')
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
  })

  it('returns different hash for different input', () => {
    const a = hashReasoning('input A')
    const b = hashReasoning('input B')
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'))
  })

  it('handles empty string', () => {
    const hash = hashReasoning('')
    expect(hash).toBeInstanceOf(Uint8Array)
    expect(hash.length).toBe(32)
  })
})

describe('riskLevelToIndex', () => {
  it('maps risk level strings to enum indices', () => {
    expect(riskLevelToIndex('conservative')).toBe(0)
    expect(riskLevelToIndex('moderate')).toBe(1)
    expect(riskLevelToIndex('aggressive')).toBe(2)
  })

  it('throws on unknown risk level', () => {
    expect(() => riskLevelToIndex('yolo')).toThrow('Unknown risk level')
  })
})

// ---------------------------------------------------------------------------
// submitRebalance — mocked Solana + filesystem
// ---------------------------------------------------------------------------

// Vitest hoists vi.mock() calls, so all mocks must be at module scope.
// We use a factory that captures a mutable ref so individual tests can
// override behaviour via mockImpl.
const mockSendAndConfirm = vi.fn()

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js')
  return {
    ...actual,
    sendAndConfirmTransaction: (...args: unknown[]) => mockSendAndConfirm(...args),
  }
})

// readFileSync + existsSync mock: intercepts /mock/keeper.json, passes through
// everything else to the real fs implementation (Anchor IDL files, etc).
const testKeypair = Keypair.generate()
const testKeypairJson = JSON.stringify(Array.from(testKeypair.secretKey))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn((path: unknown) => {
      if (path === '/mock/keeper.json') return true
      return (actual.existsSync as (p: unknown) => boolean)(path)
    }),
    readFileSync: vi.fn((path: unknown, enc?: unknown) => {
      if (path === '/mock/keeper.json') return testKeypairJson
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, enc)
    }),
  }
})

describe('submitRebalance', () => {
  const vaultUsdc = new PublicKey('So11111111111111111111111111111111111111112')
  const treasuryUsdc = new PublicKey('SysvarRent111111111111111111111111111111111')

  const baseParams = {
    rpcUrl: 'http://localhost:8899',
    keypairPath: '/mock/keeper.json',
    riskLevel: 'moderate',
    weights: { 'kamino-lending': 6000, 'marginfi-lending': 4000 },
    reasoning: 'Test rebalance',
    rebalanceCounter: 0,
    equitySnapshot: BigInt(1_000_000),
    vaultUsdcAddress: vaultUsdc,
    treasuryUsdcAddress: treasuryUsdc,
  }

  beforeEach(() => {
    mockSendAndConfirm.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns success=false when RPC rejects the transaction', async () => {
    mockSendAndConfirm.mockRejectedValue(new Error('connection refused'))

    const result = await submitRebalance(baseParams)

    expect(result.success).toBe(false)
    expect(result.error).toContain('connection refused')
    expect(result.txSignature).toBeUndefined()
  })

  it('returns success=true with tx signature on confirmed transaction', async () => {
    mockSendAndConfirm.mockResolvedValue('mockSignature123abc')

    const result = await submitRebalance(baseParams)

    expect(result.success).toBe(true)
    expect(result.txSignature).toBe('mockSignature123abc')
    expect(result.error).toBeUndefined()
  })

  it('returns success=false on unknown risk level before hitting RPC', async () => {
    // riskLevelToIndex throws synchronously — never reaches sendAndConfirmTransaction
    const result = await submitRebalance({ ...baseParams, riskLevel: 'unknown' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown risk level')
    expect(mockSendAndConfirm).not.toHaveBeenCalled()
  })

  it('returns actionable error when keypair file does not exist', async () => {
    // /nonexistent path — existsSync returns false → early return before readFileSync
    const result = await submitRebalance({ ...baseParams, keypairPath: '/nonexistent/keeper.json' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('/nonexistent/keeper.json')
    expect(result.error).toContain('KEEPER_KEYPAIR_PATH')
    expect(mockSendAndConfirm).not.toHaveBeenCalled()
  })

  it('passes the keeper public key as a signer', async () => {
    mockSendAndConfirm.mockResolvedValue('sig')

    await submitRebalance(baseParams)

    expect(mockSendAndConfirm).toHaveBeenCalledOnce()
    // Third arg to sendAndConfirmTransaction is the signers array
    const signers = mockSendAndConfirm.mock.calls[0]![2] as Keypair[]
    expect(signers[0]!.publicKey.toBase58()).toBe(testKeypair.publicKey.toBase58())
  })

  it('returns success=false when expectedAuthority does not match loaded keypair', async () => {
    const wrongAuthority = Keypair.generate().publicKey.toBase58()

    const result = await submitRebalance({ ...baseParams, expectedAuthority: wrongAuthority })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Keypair pubkey mismatch')
    expect(result.error).toContain(wrongAuthority)
    expect(mockSendAndConfirm).not.toHaveBeenCalled()
  })

  it('proceeds normally when expectedAuthority matches loaded keypair', async () => {
    mockSendAndConfirm.mockResolvedValue('sig-with-authority')

    const result = await submitRebalance({
      ...baseParams,
      expectedAuthority: testKeypair.publicKey.toBase58(),
    })

    expect(result.success).toBe(true)
    expect(result.txSignature).toBe('sig-with-authority')
  })
})
