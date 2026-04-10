import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, logger, type LogLevel } from './logger.js'

describe('log', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('outputs valid JSON to stdout for info level', () => {
    log('info', 'Cycle', 'Test message')

    expect(stdoutSpy).toHaveBeenCalledOnce()
    const line = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(line.trim())

    expect(parsed.level).toBe('info')
    expect(parsed.tag).toBe('Cycle')
    expect(parsed.message).toBe('Test message')
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp).getTime()).toBeGreaterThan(0)
  })

  it('outputs valid JSON to stdout for debug level', () => {
    log('debug', 'Test', 'debug msg')
    expect(stdoutSpy).toHaveBeenCalledOnce()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('outputs to stderr for warn level', () => {
    log('warn', 'Chain', 'Something degraded')
    expect(stderrSpy).toHaveBeenCalledOnce()
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('outputs to stderr for error level', () => {
    log('error', 'Cycle', 'Cycle failed', { error: 'timeout' })
    expect(stderrSpy).toHaveBeenCalledOnce()
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('includes extra fields in the JSON output', () => {
    log('info', 'Chain', 'Rebalance confirmed', {
      txSignature: 'sig123',
      riskLevel: 'moderate',
      weights: { 'kamino-lending': 6000 },
    })

    const line = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(line.trim())

    expect(parsed.txSignature).toBe('sig123')
    expect(parsed.riskLevel).toBe('moderate')
    expect(parsed.weights['kamino-lending']).toBe(6000)
  })

  it('output is newline-terminated', () => {
    log('info', 'T', 'msg')
    const line = stdoutSpy.mock.calls[0]![0] as string
    expect(line.endsWith('\n')).toBe(true)
  })

  for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
    it(`includes level="${level}" in JSON output`, () => {
      log(level, 'Tag', 'msg')
      const spy = level === 'warn' || level === 'error' ? stderrSpy : stdoutSpy
      const line = spy.mock.calls[0]![0] as string
      const parsed = JSON.parse(line.trim())
      expect(parsed.level).toBe(level)
    })
  }
})

describe('logger convenience wrappers', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('logger.info writes to stdout', () => {
    logger.info('T', 'msg')
    expect(stdoutSpy).toHaveBeenCalledOnce()
    const parsed = JSON.parse((stdoutSpy.mock.calls[0]![0] as string).trim())
    expect(parsed.level).toBe('info')
  })

  it('logger.warn writes to stderr', () => {
    logger.warn('T', 'msg')
    expect(stderrSpy).toHaveBeenCalledOnce()
    const parsed = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim())
    expect(parsed.level).toBe('warn')
  })

  it('logger.error writes to stderr', () => {
    logger.error('T', 'msg', { code: 42 })
    expect(stderrSpy).toHaveBeenCalledOnce()
    const parsed = JSON.parse((stderrSpy.mock.calls[0]![0] as string).trim())
    expect(parsed.level).toBe('error')
    expect(parsed.code).toBe(42)
  })

  it('logger.debug writes to stdout', () => {
    logger.debug('T', 'msg')
    expect(stdoutSpy).toHaveBeenCalledOnce()
  })
})
