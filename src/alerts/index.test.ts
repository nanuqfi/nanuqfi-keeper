import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAlerter } from './index.js'
import type { KeeperConfig } from '../config.js'

const originalFetch = globalThis.fetch

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
