import { describe, it, expect } from 'vitest'
import { checkAutoExit, type AutoExitContext } from './auto-exit.js'

// ---------------------------------------------------------------------------
// drift-basis
// ---------------------------------------------------------------------------
describe('checkAutoExit — drift-basis', () => {
  it('exits when the last 16 entries are all negative', () => {
    const fundingHistory = Array(16).fill(-0.001)
    const result = checkAutoExit('drift-basis', { fundingHistory })
    expect(result.shouldExit).toBe(true)
    expect(result.reason).toBeDefined()
  })

  it('does not exit when only 15 consecutive negative entries exist', () => {
    const fundingHistory = Array(15).fill(-0.001)
    const result = checkAutoExit('drift-basis', { fundingHistory })
    expect(result.shouldExit).toBe(false)
  })

  it('does not exit when history has mixed signs (even if len ≥ 16)', () => {
    // 15 negative + 1 positive at the end
    const fundingHistory = [...Array(15).fill(-0.001), 0.001]
    const result = checkAutoExit('drift-basis', { fundingHistory })
    expect(result.shouldExit).toBe(false)
  })

  it('only looks at the last 16 entries — older positive entries are irrelevant', () => {
    // 10 old positives followed by 16 negatives = 26 total
    const fundingHistory = [...Array(10).fill(0.001), ...Array(16).fill(-0.001)]
    const result = checkAutoExit('drift-basis', { fundingHistory })
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit when fundingHistory is absent', () => {
    const result = checkAutoExit('drift-basis', {})
    expect(result.shouldExit).toBe(false)
  })

  it('does not exit when fundingHistory is empty', () => {
    const result = checkAutoExit('drift-basis', { fundingHistory: [] })
    expect(result.shouldExit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// drift-funding
// ---------------------------------------------------------------------------
describe('checkAutoExit — drift-funding', () => {
  it('exits for moderate risk when PnL ≤ -2%', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.025, riskLevel: 'moderate' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit for moderate risk when PnL is -1.5%', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.015, riskLevel: 'moderate' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(false)
  })

  it('exits for conservative risk when PnL ≤ -2% (same threshold as moderate)', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.02, riskLevel: 'conservative' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit for aggressive risk when PnL is -3%', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.03, riskLevel: 'aggressive' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(false)
  })

  it('exits for aggressive risk when PnL ≤ -5%', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.06, riskLevel: 'aggressive' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(true)
  })

  it('exits at exactly -5% for aggressive risk (boundary)', () => {
    const ctx: AutoExitContext = { unrealizedPnlPercent: -0.05, riskLevel: 'aggressive' }
    const result = checkAutoExit('drift-funding', ctx)
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit when unrealizedPnlPercent is absent', () => {
    const result = checkAutoExit('drift-funding', { riskLevel: 'moderate' })
    expect(result.shouldExit).toBe(false)
  })

  it('falls back to moderate threshold when riskLevel is absent', () => {
    // -2.5% should trigger the moderate (-2%) threshold
    const result = checkAutoExit('drift-funding', { unrealizedPnlPercent: -0.025 })
    expect(result.shouldExit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// drift-insurance
// ---------------------------------------------------------------------------
describe('checkAutoExit — drift-insurance', () => {
  it('exits when insurance fund drawdown is 35%', () => {
    const result = checkAutoExit('drift-insurance', { insuranceFundDrawdown: 0.35 })
    expect(result.shouldExit).toBe(true)
    expect(result.reason).toBeDefined()
  })

  it('does not exit when drawdown is 25%', () => {
    const result = checkAutoExit('drift-insurance', { insuranceFundDrawdown: 0.25 })
    expect(result.shouldExit).toBe(false)
  })

  it('exits at exactly 30% (boundary)', () => {
    const result = checkAutoExit('drift-insurance', { insuranceFundDrawdown: 0.30 })
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit when insuranceFundDrawdown is absent', () => {
    const result = checkAutoExit('drift-insurance', {})
    expect(result.shouldExit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// drift-jito-dn
// ---------------------------------------------------------------------------
describe('checkAutoExit — drift-jito-dn', () => {
  it('exits when borrow rate (8%) ≥ staking yield (7%)', () => {
    const ctx: AutoExitContext = { solBorrowRate: 0.08, jitoStakingYield: 0.07 }
    const result = checkAutoExit('drift-jito-dn', ctx)
    expect(result.shouldExit).toBe(true)
    expect(result.reason).toBeDefined()
  })

  it('does not exit when borrow rate (6%) < staking yield (7%)', () => {
    const ctx: AutoExitContext = { solBorrowRate: 0.06, jitoStakingYield: 0.07 }
    const result = checkAutoExit('drift-jito-dn', ctx)
    expect(result.shouldExit).toBe(false)
  })

  it('exits when borrow rate equals staking yield (carry = 0)', () => {
    const ctx: AutoExitContext = { solBorrowRate: 0.07, jitoStakingYield: 0.07 }
    const result = checkAutoExit('drift-jito-dn', ctx)
    expect(result.shouldExit).toBe(true)
  })

  it('does not exit when solBorrowRate is absent', () => {
    const result = checkAutoExit('drift-jito-dn', { jitoStakingYield: 0.07 })
    expect(result.shouldExit).toBe(false)
  })

  it('does not exit when jitoStakingYield is absent', () => {
    const result = checkAutoExit('drift-jito-dn', { solBorrowRate: 0.08 })
    expect(result.shouldExit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unknown backend
// ---------------------------------------------------------------------------
describe('checkAutoExit — unknown backend', () => {
  it('never exits for an unknown backend', () => {
    const ctx: AutoExitContext = {
      fundingHistory: Array(20).fill(-0.001),
      unrealizedPnlPercent: -0.10,
      insuranceFundDrawdown: 0.99,
      solBorrowRate: 1.0,
      jitoStakingYield: 0.01,
    }
    const result = checkAutoExit('some-future-backend', ctx)
    expect(result.shouldExit).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('never exits for an empty string backend', () => {
    const result = checkAutoExit('', {})
    expect(result.shouldExit).toBe(false)
  })
})
