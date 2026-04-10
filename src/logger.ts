/**
 * Structured JSON logging for the NanuqFi keeper.
 *
 * Outputs `{ timestamp, level, tag, message, ...extra }` JSON to stdout/stderr.
 * Drop-in replacement for scattered `console.log('[Tag] message')` calls on
 * critical paths (runCycle, submitRebalance) — machine-parseable by log
 * aggregators (Loki, Datadog, CloudWatch, etc.).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  tag: string
  message: string
  [key: string]: unknown
}

/**
 * Write a structured JSON log line to stdout (info/debug) or stderr (warn/error).
 */
export function log(
  level: LogLevel,
  tag: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    tag,
    message,
    ...extra,
  }
  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

/** Convenience wrappers */
export const logger = {
  debug: (tag: string, message: string, extra?: Record<string, unknown>) =>
    log('debug', tag, message, extra),
  info: (tag: string, message: string, extra?: Record<string, unknown>) =>
    log('info', tag, message, extra),
  warn: (tag: string, message: string, extra?: Record<string, unknown>) =>
    log('warn', tag, message, extra),
  error: (tag: string, message: string, extra?: Record<string, unknown>) =>
    log('error', tag, message, extra),
}
