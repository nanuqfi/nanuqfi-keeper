import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import {
  deriveAllocatorPda,
  deriveRiskVaultPda,
  deriveRebalanceRecordPda,
  deriveTreasuryPda,
  weightsToU16Array,
  hashReasoning,
  riskLevelToIndex,
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
      'drift-lending': 5000,
      'drift-basis': 3000,
      'drift-jito-dn': 2000,
    }
    const backendOrder = ['drift-lending', 'drift-basis', 'drift-jito-dn']
    const result = weightsToU16Array(weights, backendOrder)

    expect(result).toEqual([5000, 3000, 2000])
  })

  it('fills missing backends with 0', () => {
    const weights: Record<string, number> = {
      'drift-lending': 10000,
    }
    const backendOrder = ['drift-lending', 'drift-basis', 'drift-jito-dn']
    const result = weightsToU16Array(weights, backendOrder)

    expect(result).toEqual([10000, 0, 0])
  })

  it('handles all-zero weights', () => {
    const result = weightsToU16Array({}, ['drift-lending', 'drift-basis'])
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
