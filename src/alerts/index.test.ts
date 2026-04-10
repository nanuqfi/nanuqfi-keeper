import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createAlerter, isAlertThrottled, clearThrottleCache } from './index.js'
import type { KeeperConfig } from '../config.js'

const originalFetch = globalThis.fetch

beforeEach(() => {
  // Reset throttle state between tests — prevents cross-test contamination
  clearThrottleCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function baseConfig(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    rpcUrls: [],
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

describe('createAlerter', () => {
  it('returns a no-op alerter when token is missing', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { alert } = createAlerter(baseConfig({ alertTelegramChatId: '123' }))

    await alert('test message')

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Alert]'),
      expect.stringContaining('test message'),
    )
    consoleSpy.mockRestore()
  })

  it('returns a no-op alerter when chatId is missing', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { alert } = createAlerter(baseConfig({ alertTelegramToken: 'tok' }))

    await alert('test message')

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Alert]'),
      expect.stringContaining('test message'),
    )
    consoleSpy.mockRestore()
  })

  it('sends via Telegram when both token and chatId are set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const { alert } = createAlerter(baseConfig({
      alertTelegramToken: 'tok123',
      alertTelegramChatId: '456',
    }))

    await alert('critical alert')

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toContain('tok123')
  })

  it('does not throw when Telegram send fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const { alert } = createAlerter(baseConfig({
      alertTelegramToken: 'tok',
      alertTelegramChatId: 'chat',
    }))

    await expect(alert('msg')).resolves.toBeUndefined()
  })
})

describe('isAlertThrottled', () => {
  it('returns false on first call for a message', () => {
    expect(isAlertThrottled('first message')).toBe(false)
  })

  it('returns true on second call with the same message (within throttle window)', () => {
    isAlertThrottled('repeated message') // first call — records timestamp
    expect(isAlertThrottled('repeated message')).toBe(true)
  })

  it('returns false for different messages independently', () => {
    expect(isAlertThrottled('message A')).toBe(false)
    expect(isAlertThrottled('message B')).toBe(false)
  })

  it('clears cache removes all throttle state', () => {
    isAlertThrottled('cached message') // mark as sent
    clearThrottleCache()
    expect(isAlertThrottled('cached message')).toBe(false) // should not be throttled after clear
  })
})

describe('throttling in createAlerter', () => {
  it('suppresses duplicate no-op alerts within throttle window', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { alert } = createAlerter(baseConfig())

    await alert('duplicate alert')
    await alert('duplicate alert') // should be throttled

    // First call: '[Alert] (no Telegram configured) ...'
    // Second call: '[Alert] Throttled ...'
    const allCalls = consoleSpy.mock.calls.map(c => c.join(' '))
    expect(allCalls.some(c => c.includes('Throttled'))).toBe(true)
    consoleSpy.mockRestore()
  })

  it('suppresses duplicate Telegram alerts within throttle window', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const { alert } = createAlerter(baseConfig({
      alertTelegramToken: 'tok123',
      alertTelegramChatId: '456',
    }))

    await alert('critical failure')
    await alert('critical failure') // throttled — should not hit fetch again

    // Only one fetch call — second was dropped
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('allows different messages through independently', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    })

    const { alert } = createAlerter(baseConfig({
      alertTelegramToken: 'tok123',
      alertTelegramChatId: '456',
    }))

    await alert('alert alpha')
    await alert('alert beta') // different message — not throttled

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
