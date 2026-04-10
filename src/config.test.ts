import { describe, it, expect } from 'vitest'
import { validateConfig, type KeeperConfig } from './config.js'

function validConfig(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    rpcUrls: ['https://api.devnet.solana.com'],
    keeperKeypairPath: '',
    cycleIntervalMs: 600_000,
    aiCycleIntervalMs: 7_200_000,
    aiApiKey: '',
    aiModel: 'claude-sonnet-4-6',
    aiMaxCallsPerHour: 10,
    aiBudgetPerDay: 5,
    ...overrides,
  }
}

describe('validateConfig', () => {
  it('accepts a valid config without throwing', () => {
    expect(() => validateConfig(validConfig())).not.toThrow()
  })

  describe('cycleIntervalMs', () => {
    it('throws when cycleIntervalMs is NaN (e.g. bad env var)', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: NaN }))).toThrow(
        /cycleIntervalMs/
      )
    })

    it('throws when cycleIntervalMs is Infinity', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: Infinity }))).toThrow(
        /cycleIntervalMs/
      )
    })

    it('throws when cycleIntervalMs is negative', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: -1 }))).toThrow(
        /cycleIntervalMs/
      )
    })

    it('throws when cycleIntervalMs is zero', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: 0 }))).toThrow(
        /cycleIntervalMs/
      )
    })

    it('throws when cycleIntervalMs is below 10s minimum (e.g. 5000)', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: 5_000 }))).toThrow(
        /cycleIntervalMs/
      )
    })

    it('accepts cycleIntervalMs exactly at 10s minimum', () => {
      expect(() => validateConfig(validConfig({ cycleIntervalMs: 10_000 }))).not.toThrow()
    })
  })

  describe('aiCycleIntervalMs', () => {
    it('throws when aiCycleIntervalMs is NaN', () => {
      expect(() => validateConfig(validConfig({ aiCycleIntervalMs: NaN }))).toThrow(
        /aiCycleIntervalMs/
      )
    })

    it('throws when aiCycleIntervalMs is zero', () => {
      expect(() => validateConfig(validConfig({ aiCycleIntervalMs: 0 }))).toThrow(
        /aiCycleIntervalMs/
      )
    })

    it('accepts a positive finite aiCycleIntervalMs', () => {
      expect(() => validateConfig(validConfig({ aiCycleIntervalMs: 3_600_000 }))).not.toThrow()
    })
  })

  describe('rpcUrls', () => {
    it('throws when rpcUrls is empty array', () => {
      expect(() => validateConfig(validConfig({ rpcUrls: [] }))).toThrow(/rpcUrls/)
    })

    it('accepts a single valid rpcUrl', () => {
      expect(() => validateConfig(validConfig({ rpcUrls: ['https://api.mainnet-beta.solana.com'] }))).not.toThrow()
    })

    it('accepts multiple rpcUrls', () => {
      expect(() =>
        validateConfig(validConfig({ rpcUrls: ['https://a.rpc.com', 'https://b.rpc.com'] }))
      ).not.toThrow()
    })
  })

  describe('error message quality', () => {
    it('error message includes actionable info about env var to fix', () => {
      let message = ''
      try {
        validateConfig(validConfig({ cycleIntervalMs: NaN }))
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain('CYCLE_INTERVAL_MS')
    })

    it('error message lists all violations when multiple fields are invalid', () => {
      let message = ''
      try {
        validateConfig(validConfig({ cycleIntervalMs: NaN, rpcUrls: [] }))
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain('cycleIntervalMs')
      expect(message).toContain('rpcUrls')
    })
  })
})
