import { describe, it, expect } from 'vitest'
import { checkAutoExit, type AutoExitContext } from './auto-exit.js'

// ---------------------------------------------------------------------------
// Lending backends — no auto-exit triggers
// ---------------------------------------------------------------------------
describe('checkAutoExit — lending backends', () => {
  it('never exits for kamino-lending', () => {
    const ctx: AutoExitContext = { riskLevel: 'moderate' }
    const result = checkAutoExit('kamino-lending', ctx)
    expect(result.shouldExit).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('never exits for marginfi-lending', () => {
    const ctx: AutoExitContext = { riskLevel: 'conservative' }
    const result = checkAutoExit('marginfi-lending', ctx)
    expect(result.shouldExit).toBe(false)
  })

  it('never exits for lulo-lending', () => {
    const ctx: AutoExitContext = { riskLevel: 'aggressive' }
    const result = checkAutoExit('lulo-lending', ctx)
    expect(result.shouldExit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unknown / future backends — safe default
// ---------------------------------------------------------------------------
describe('checkAutoExit — unknown backend', () => {
  it('never exits for an unknown backend', () => {
    const ctx: AutoExitContext = { riskLevel: 'moderate' }
    const result = checkAutoExit('some-future-backend', ctx)
    expect(result.shouldExit).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('never exits for an empty string backend', () => {
    const result = checkAutoExit('', {})
    expect(result.shouldExit).toBe(false)
  })

  it('never exits when context is empty', () => {
    const result = checkAutoExit('any-backend', {})
    expect(result.shouldExit).toBe(false)
  })
})
