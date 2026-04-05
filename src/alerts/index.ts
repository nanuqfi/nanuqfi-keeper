import type { KeeperConfig } from '../config.js'
import { sendTelegramAlert } from './telegram.js'

export { sendTelegramAlert } from './telegram.js'

export interface Alerter {
  alert: (message: string) => Promise<void>
}

/**
 * Create an alerter from keeper config.
 * If Telegram token/chatId are missing, returns a no-op alerter that logs to console.
 */
export function createAlerter(config: KeeperConfig): Alerter {
  const { alertTelegramToken, alertTelegramChatId } = config

  if (!alertTelegramToken || !alertTelegramChatId) {
    return {
      alert: async (message: string) => {
        console.log('[Alert] (no Telegram configured)', message)
      },
    }
  }

  return {
    alert: async (message: string) => {
      await sendTelegramAlert(alertTelegramToken, alertTelegramChatId, message)
    },
  }
}
