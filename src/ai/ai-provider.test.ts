import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock the Anthropic SDK before importing the provider ─────────────────────
// vi.mock is hoisted, so mockCreate must live in module scope.
const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

// Import AFTER the mock is registered
import { AIProvider, type AIProviderConfig } from './ai-provider.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    apiKey: 'test-api-key',
    model: 'claude-sonnet-4-6',
    maxCallsPerHour: 5,
    budgetPerDay: 2,
    ...overrides,
  }
}

/** Simulate a successful Claude API response. */
function mockSuccess(text: string): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  })
}

/** Simulate a failed Claude API call. */
function mockFailure(message = 'API error'): void {
  mockCreate.mockRejectedValueOnce(new Error(message))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AIProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockCreate.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Successful call ────────────────────────────────────────────────────────

  describe('analyze — happy path', () => {
    it('returns the raw response text from Claude', async () => {
      const provider = new AIProvider(makeConfig())
      const expected = '{"weights":{"kamino-lending":60,"marginfi-lending":40},"confidence":0.9,"reasoning":"Lending rates stable."}'
      mockSuccess(expected)

      const result = await provider.analyze('Test prompt')
      expect(result).toBe(expected)
    })

    it('passes the prompt to the Anthropic messages.create call', async () => {
      const provider = new AIProvider(makeConfig())
      mockSuccess('{}')

      await provider.analyze('My test prompt')

      expect(mockCreate).toHaveBeenCalledOnce()
      const call = mockCreate.mock.calls[0]![0]
      expect(call.messages[0].content).toBe('My test prompt')
      expect(call.messages[0].role).toBe('user')
    })

    it('uses the model from config', async () => {
      const provider = new AIProvider(makeConfig({ model: 'claude-opus-4-5' }))
      mockSuccess('{}')

      await provider.analyze('prompt')

      const call = mockCreate.mock.calls[0]![0]
      expect(call.model).toBe('claude-opus-4-5')
    })

    it('increments callsThisHour after a successful call', async () => {
      const provider = new AIProvider(makeConfig())
      mockSuccess('{}')

      expect(provider.callsThisHour).toBe(0)
      await provider.analyze('prompt')
      expect(provider.callsThisHour).toBe(1)
    })

    it('throws when response has no text content block', async () => {
      const provider = new AIProvider(makeConfig())
      mockCreate.mockResolvedValueOnce({ content: [] })

      await expect(provider.analyze('prompt')).rejects.toThrow('no text content block')
    })

    it('throws when response content block is not type text', async () => {
      const provider = new AIProvider(makeConfig())
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'x' }] })

      await expect(provider.analyze('prompt')).rejects.toThrow('no text content block')
    })
  })

  // ── Rate limiting ──────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('rejects analyze() after exceeding maxCallsPerHour', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 3 }))

      // Fill up the rate limit quota
      for (let i = 0; i < 3; i++) {
        mockSuccess('{}')
        await provider.analyze('prompt')
      }

      // Next call must be rejected — no SDK call should happen
      await expect(provider.analyze('prompt')).rejects.toThrow('rate limit exceeded')
      expect(mockCreate).toHaveBeenCalledTimes(3)
    })

    it('isAvailable returns false when rate limited', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 2 }))

      mockSuccess('{}')
      await provider.analyze('prompt')
      mockSuccess('{}')
      await provider.analyze('prompt')

      expect(provider.isAvailable).toBe(false)
    })

    it('isAvailable returns true when under the rate limit', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 10 }))
      expect(provider.isAvailable).toBe(true)
    })

    it('sliding window: calls older than 1h are evicted and quota resets', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 2 }))

      mockSuccess('{}')
      await provider.analyze('prompt')
      mockSuccess('{}')
      await provider.analyze('prompt')

      // Rate limited now
      expect(provider.isAvailable).toBe(false)

      // Advance time past the 1-hour window
      vi.advanceTimersByTime(60 * 60 * 1_000 + 1)

      // Old timestamps evicted — should be available again
      expect(provider.isAvailable).toBe(true)
      expect(provider.callsThisHour).toBe(0)
    })

    it('callsThisHour reflects only calls within the current window', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 10 }))

      mockSuccess('{}')
      await provider.analyze('p1')
      mockSuccess('{}')
      await provider.analyze('p2')

      expect(provider.callsThisHour).toBe(2)

      // Advance past window
      vi.advanceTimersByTime(60 * 60 * 1_000 + 1)
      expect(provider.callsThisHour).toBe(0)
    })
  })

  // ── Circuit breaker ────────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('allows calls while failures stay below threshold', async () => {
      const provider = new AIProvider(makeConfig())

      // 2 failures (threshold is 3) — still closed
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow('API error')
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow('API error')

      // Third call should still reach the SDK (not blocked by circuit)
      mockSuccess('{}')
      await expect(provider.analyze('p')).resolves.toBe('{}')
    })

    it('opens circuit after 3 consecutive failures', async () => {
      const provider = new AIProvider(makeConfig())

      for (let i = 0; i < 3; i++) {
        mockFailure()
        await expect(provider.analyze('p')).rejects.toThrow()
      }

      // Circuit is now open — 4th call must be rejected without hitting SDK
      const callsBefore = mockCreate.mock.calls.length
      await expect(provider.analyze('p')).rejects.toThrow('circuit breaker is open')
      expect(mockCreate.mock.calls.length).toBe(callsBefore)
    })

    it('isAvailable returns false when circuit is open', async () => {
      const provider = new AIProvider(makeConfig())

      for (let i = 0; i < 3; i++) {
        mockFailure()
        await expect(provider.analyze('p')).rejects.toThrow()
      }

      expect(provider.isAvailable).toBe(false)
    })

    it('resets circuit after 30 seconds and allows new calls', async () => {
      const provider = new AIProvider(makeConfig())

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        mockFailure()
        await expect(provider.analyze('p')).rejects.toThrow()
      }

      expect(provider.isAvailable).toBe(false)

      // Advance time past the reset window
      vi.advanceTimersByTime(30_000 + 1)

      expect(provider.isAvailable).toBe(true)
    })

    it('circuit does not reset before 30 seconds have elapsed', async () => {
      const provider = new AIProvider(makeConfig())

      for (let i = 0; i < 3; i++) {
        mockFailure()
        await expect(provider.analyze('p')).rejects.toThrow()
      }

      vi.advanceTimersByTime(29_999)

      expect(provider.isAvailable).toBe(false)
    })

    it('consecutive failure counter resets after a successful call', async () => {
      // Use a high rate limit so it doesn't interfere with circuit-breaker logic
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 20 }))

      // 2 failures
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow()
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow()

      // 1 success — resets counter
      mockSuccess('ok')
      await provider.analyze('p')

      // 2 more failures — circuit should still be closed (counter started from 0)
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow()
      mockFailure()
      await expect(provider.analyze('p')).rejects.toThrow()

      expect(provider.isAvailable).toBe(true)
    })

    it('circuit opens when 3 failures are consecutive even across different prompts', async () => {
      const provider = new AIProvider(makeConfig())

      mockFailure('err-a')
      await expect(provider.analyze('prompt-a')).rejects.toThrow()
      mockFailure('err-b')
      await expect(provider.analyze('prompt-b')).rejects.toThrow()
      mockFailure('err-c')
      await expect(provider.analyze('prompt-c')).rejects.toThrow()

      expect(provider.isAvailable).toBe(false)
    })
  })

  // ── isAvailable composite ──────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('returns true for a fresh provider with no calls', () => {
      const provider = new AIProvider(makeConfig())
      expect(provider.isAvailable).toBe(true)
    })

    it('returns false when both rate limited and circuit open simultaneously', async () => {
      const provider = new AIProvider(makeConfig({ maxCallsPerHour: 3 }))

      // 3 failures → opens circuit AND fills rate limit
      for (let i = 0; i < 3; i++) {
        mockFailure()
        await expect(provider.analyze('p')).rejects.toThrow()
      }

      expect(provider.isAvailable).toBe(false)
    })
  })
})
