import Anthropic from '@anthropic-ai/sdk'

export interface AIProviderConfig {
  apiKey: string
  model: string
  baseURL?: string    // OpenRouter: 'https://openrouter.ai/api/v1'
  maxCallsPerHour: number
  budgetPerDay: number  // USD (tracked for observability; enforcement is advisory)
}

/** How many consecutive failures before the circuit opens. */
const CIRCUIT_OPEN_AFTER_FAILURES = 3

/** How long the circuit stays open before automatically resetting (ms). */
const CIRCUIT_RESET_MS = 30_000

/** Sliding window for rate limiting (ms). */
const RATE_WINDOW_MS = 60 * 60 * 1_000  // 1 hour

type CircuitState = 'CLOSED' | 'OPEN'

export class AIProvider {
  private readonly client: Anthropic
  private readonly config: AIProviderConfig

  // Rate limiting — timestamps of successful or attempted calls within the window
  private callTimestamps: number[] = []

  // Circuit breaker
  private circuitState: CircuitState = 'CLOSED'
  private consecutiveFailures = 0
  private circuitOpenedAt: number | null = null

  constructor(config: AIProviderConfig) {
    this.config = config
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    })
  }

  /**
   * Returns false if the provider is rate-limited OR if the circuit breaker is open.
   */
  get isAvailable(): boolean {
    this.evictExpiredTimestamps()
    this.maybeResetCircuit()
    return this.circuitState === 'CLOSED' && !this.isRateLimited()
  }

  /**
   * Number of calls recorded in the current sliding-window hour.
   */
  get callsThisHour(): number {
    this.evictExpiredTimestamps()
    return this.callTimestamps.length
  }

  /**
   * Send a prompt to Claude and return the raw response text.
   * Throws if rate-limited, circuit-open, or the API call fails.
   */
  async analyze(prompt: string): Promise<string> {
    this.evictExpiredTimestamps()
    this.maybeResetCircuit()

    if (this.isRateLimited()) {
      throw new Error(
        `AIProvider: rate limit exceeded — ${this.callTimestamps.length}/${this.config.maxCallsPerHour} calls used this hour`
      )
    }

    if (this.circuitState === 'OPEN') {
      throw new Error(
        `AIProvider: circuit breaker is open — too many consecutive failures, retry after ${CIRCUIT_RESET_MS / 1_000}s`
      )
    }

    // Record the call attempt in the rate-limit window
    this.callTimestamps.push(Date.now())

    try {
      const message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      })

      // Extract text from the first content block
      const block = message.content[0]
      if (!block || block.type !== 'text') {
        throw new Error('AIProvider: unexpected response — no text content block in API response')
      }

      // Success — reset consecutive failure counter
      this.consecutiveFailures = 0

      return block.text
    } catch (err) {
      this.consecutiveFailures++

      if (this.consecutiveFailures >= CIRCUIT_OPEN_AFTER_FAILURES) {
        this.circuitState = 'OPEN'
        this.circuitOpenedAt = Date.now()
      }

      throw err
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private evictExpiredTimestamps(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS
    this.callTimestamps = this.callTimestamps.filter((ts) => ts > cutoff)
  }

  private isRateLimited(): boolean {
    return this.callTimestamps.length >= this.config.maxCallsPerHour
  }

  private maybeResetCircuit(): void {
    if (
      this.circuitState === 'OPEN' &&
      this.circuitOpenedAt !== null &&
      Date.now() - this.circuitOpenedAt >= CIRCUIT_RESET_MS
    ) {
      this.circuitState = 'CLOSED'
      this.consecutiveFailures = 0
      this.circuitOpenedAt = null
    }
  }
}
