import type { KeeperConfig } from '../config.js'
import { sendTelegramAlert } from './telegram.js'

export { sendTelegramAlert } from './telegram.js'

export interface Alerter {
  alert: (message: string) => Promise<void>
}

// ─── Throttling ──────────────────────────────────────────────────────────────
// Prevent duplicate alerts from flooding Telegram on repeated failures.
// The same message is suppressed if it was sent within the last 5 minutes.

const THROTTLE_WINDOW_MS = 300_000 // 5 minutes

// message → timestamp of last successful send
const recentAlerts = new Map<string, number>()

// Periodic cleanup — prevents unbounded map growth on a long-running process
setInterval(() => {
  const now = Date.now()
  for (const [msg, sentAt] of recentAlerts) {
    if (now - sentAt >= THROTTLE_WINDOW_MS) recentAlerts.delete(msg)
  }
}, THROTTLE_WINDOW_MS).unref()

/**
 * Returns true if this message was already sent within the throttle window.
 * Records the send timestamp when not throttled.
 */
export function isAlertThrottled(message: string): boolean {
  const now = Date.now()
  const lastSent = recentAlerts.get(message)
  if (lastSent !== undefined && now - lastSent < THROTTLE_WINDOW_MS) return true
  recentAlerts.set(message, now)
  return false
}

/** Clear the throttle cache — exposed for testing only. */
export function clearThrottleCache(): void {
  recentAlerts.clear()
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an alerter from keeper config.
 * If Telegram token/chatId are missing, returns a no-op alerter that logs to console.
 * All alerters apply the 5-minute dedup window — duplicates are logged and dropped.
 */
export function createAlerter(config: KeeperConfig): Alerter {
  const { alertTelegramToken, alertTelegramChatId } = config

  if (!alertTelegramToken || !alertTelegramChatId) {
    return {
      alert: async (message: string) => {
        if (isAlertThrottled(message)) {
          console.log('[Alert] Throttled (duplicate within 5min):', message)
          return
        }
        console.log('[Alert] (no Telegram configured)', message)
      },
    }
  }

  return {
    alert: async (message: string) => {
      if (isAlertThrottled(message)) {
        console.log('[Alert] Throttled (duplicate within 5min):', message)
        return
      }
      await sendTelegramAlert(alertTelegramToken, alertTelegramChatId, message)
    },
  }
}
