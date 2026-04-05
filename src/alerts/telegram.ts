const TELEGRAM_API = 'https://api.telegram.org/bot'
const TIMEOUT_MS = 5_000

/**
 * Send a message via Telegram Bot API.
 * Returns true on success, false on any failure.
 * Never throws — alerts must not crash the keeper.
 */
export async function sendTelegramAlert(
  token: string,
  chatId: string,
  message: string,
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      console.warn(`[Telegram] API error: ${res.status}`)
      return false
    }

    return true
  } catch (err) {
    console.warn(`[Telegram] Send failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}
