import { describe, it, expect } from 'vitest'
import { buildPrompt, buildInsightPrompt, type MarketContext } from './prompt-builder.js'

function makeContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    vaultTvl: { conservative: 50_000, aggressive: 30_000, dynamic: 20_000 },
    currentPositions: [
      { name: 'kamino-lending', allocation: 55 },
      { name: 'marginfi-lending', allocation: 45 },
    ],
    fundingRates: { BTC: 0.0025, SOL: -0.0008, ETH: 0.0012 },
    lendingApy: 0.065,
    insuranceYield: 0.048,
    recentLiquidationVolume: 125_000,
    oracleDeviation: { BTC: 0.12, SOL: 0.05 },
    ...overrides,
  }
}

describe('buildPrompt', () => {
  describe('role and identity', () => {
    it('includes "strategy advisor" to establish Claude\'s role', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('strategy advisor')
    })

    it('mentions NanuqFi in the prompt', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('NanuqFi')
    })
  })

  describe('TVL data', () => {
    it('includes vault TVL values in the prompt', () => {
      const prompt = buildPrompt(makeContext())
      // Total TVL = 100,000
      expect(prompt).toContain('100,000')
    })

    it('includes individual vault TVL breakdown', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('conservative')
      expect(prompt).toContain('aggressive')
      expect(prompt).toContain('dynamic')
    })

    it('reflects custom TVL values correctly', () => {
      const prompt = buildPrompt(makeContext({ vaultTvl: { 'solo-vault': 999_000 } }))
      expect(prompt).toContain('999,000')
      expect(prompt).toContain('solo-vault')
    })
  })

  describe('lending rates', () => {
    it('includes lending rate section in the prompt', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toMatch(/lending rate/i)
    })

    it('includes all funding rate assets', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('BTC')
      expect(prompt).toContain('SOL')
      expect(prompt).toContain('ETH')
    })

    it('formats funding rates as percentage', () => {
      // 0.0025 → 0.2500% per 8h
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('0.2500%')
    })

    it('handles negative funding rates without throwing', () => {
      const ctx = makeContext({ fundingRates: { SOL: -0.001 } })
      expect(() => buildPrompt(ctx)).not.toThrow()
      const prompt = buildPrompt(ctx)
      expect(prompt).toContain('-0.1000%')
    })
  })

  describe('output format instruction', () => {
    it('includes JSON format instruction', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toMatch(/json/i)
    })

    it('instructs Claude to respond ONLY with JSON (no markdown)', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toMatch(/only with.*json|respond.*only.*json/i)
      expect(prompt).toContain('no markdown')
    })

    it('includes "weights" key in the example JSON block', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('"weights"')
    })

    it('includes "confidence" key in the example JSON block', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('"confidence"')
    })

    it('includes "reasoning" key in the example JSON block', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('"reasoning"')
    })

    it('instructs that weights must sum to 100', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('100')
      expect(prompt).toMatch(/sum/i)
    })

    it('warns against code fences / prose', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toMatch(/no code fences|no prose/i)
    })
  })

  describe('positions', () => {
    it('includes current position names', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('kamino-lending')
      expect(prompt).toContain('marginfi-lending')
    })

    it('shows "(none)" when positions array is empty', () => {
      const prompt = buildPrompt(makeContext({ currentPositions: [] }))
      expect(prompt).toContain('(none)')
    })
  })

  describe('lending APY display', () => {
    it('includes Kamino supply APY', () => {
      // 0.065 → 6.5000%
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('6.5000%')
    })

    it('includes Marginfi lending APY', () => {
      // 0.048 → 4.8000%
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('4.8000%')
    })
  })

  describe('liquidation volume', () => {
    it('includes recent liquidation volume', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toContain('125,000')
    })
  })

  describe('oracle deviation', () => {
    it('includes oracle deviation data', () => {
      const prompt = buildPrompt(makeContext())
      expect(prompt).toMatch(/oracle deviation/i)
      expect(prompt).toContain('BTC')
      expect(prompt).toContain('SOL')
    })
  })

  describe('edge cases', () => {
    it('returns a non-empty string for a minimal context', () => {
      const ctx = makeContext({
        vaultTvl: {},
        currentPositions: [],
        fundingRates: {},
        oracleDeviation: {},
      })
      const prompt = buildPrompt(ctx)
      expect(typeof prompt).toBe('string')
      expect(prompt.length).toBeGreaterThan(100)
    })

    it('handles zero TVL without throwing', () => {
      const ctx = makeContext({ vaultTvl: { conservative: 0 } })
      expect(() => buildPrompt(ctx)).not.toThrow()
    })
  })
})

describe('buildInsightPrompt', () => {
  const baseContext: MarketContext = {
    vaultTvl: { moderate: 50_000, aggressive: 20_000 },
    currentPositions: [
      { name: 'kamino-lending', allocation: 56.7 },
      { name: 'marginfi-lending', allocation: 43.3 },
    ],
    fundingRates: {},
    lendingApy: 0.021,
    insuranceYield: 0,
    recentLiquidationVolume: 150_000,
    oracleDeviation: { SOL: 0.12 },
  }

  it('asks for per-strategy confidence scores, not weights', () => {
    const prompt = buildInsightPrompt(baseContext, ['kamino-lending', 'marginfi-lending'])
    expect(prompt).toContain('confidence')
    expect(prompt).toContain('0.0')
    expect(prompt).toContain('1.0')
    expect(prompt).not.toContain('sum to exactly 100')
  })

  it('includes risk_elevated field in example', () => {
    const prompt = buildInsightPrompt(baseContext, ['kamino-lending'])
    expect(prompt).toContain('risk_elevated')
  })

  it('includes strategy names in prompt', () => {
    const prompt = buildInsightPrompt(baseContext, ['kamino-lending', 'marginfi-lending'])
    expect(prompt).toContain('kamino-lending')
    expect(prompt).toContain('marginfi-lending')
  })

  it('includes market data', () => {
    const prompt = buildInsightPrompt(baseContext, ['kamino-lending'])
    expect(prompt).toContain('50,000')
    expect(prompt).toContain('KAMINO SUPPLY APY')
    expect(prompt).toContain('LENDING RATES')
  })
})
