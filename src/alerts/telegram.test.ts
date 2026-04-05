import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendTelegramAlert } from './telegram.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('sendTelegramAlert', () => {
  it('sends successfully and returns true', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    })

    const result = await sendTelegramAlert('tok123', '456', 'Test alert')

    expect(result).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledOnce()

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bottok123/sendMessage')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.chat_id).toBe('456')
    expect(body.text).toBe('Test alert')
    expect(body.parse_mode).toBe('HTML')
  })

  it('returns false on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await sendTelegramAlert('tok', 'chat', 'msg')

    expect(result).toBe(false)
  })

  it('returns false on Telegram API error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })

    const result = await sendTelegramAlert('bad-token', 'chat', 'msg')

    expect(result).toBe(false)
  })

  it('does not throw on any failure', async () => {
    // fetch throws
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(sendTelegramAlert('t', 'c', 'm')).resolves.toBe(false)

    // fetch returns non-ok
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(sendTelegramAlert('t', 'c', 'm')).resolves.toBe(false)

    // fetch hangs — AbortController should fire
    globalThis.fetch = vi.fn().mockImplementation(() =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 6000))
    )
    await expect(sendTelegramAlert('t', 'c', 'm')).resolves.toBe(false)
  }, 10_000)

  it('respects 5s timeout', async () => {
    const start = Date.now()
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    )

    const result = await sendTelegramAlert('t', 'c', 'm')
    const elapsed = Date.now() - start

    expect(result).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(4900)
    expect(elapsed).toBeLessThan(7000)
  }, 10_000)
})
