import { describe, it, expect, beforeEach } from 'vitest'
import { HealthMonitor } from './monitor'

describe('HealthMonitor', () => {
  let monitor: HealthMonitor

  beforeEach(() => {
    monitor = new HealthMonitor()
  })

  it('starts with zero cycles', () => {
    const status = monitor.getStatus()
    expect(status.cyclesCompleted).toBe(0)
    expect(status.cyclesFailed).toBe(0)
    expect(status.lastCycleTimestamp).toBe(0)
  })

  it('tracks uptime', () => {
    const status = monitor.getStatus()
    expect(status.uptime).toBeGreaterThanOrEqual(0)
  })

  it('records successful cycles', () => {
    monitor.recordCycleSuccess()
    monitor.recordCycleSuccess()
    const status = monitor.getStatus()
    expect(status.cyclesCompleted).toBe(2)
    expect(status.lastCycleTimestamp).toBeGreaterThan(0)
  })

  it('records failed cycles with error', () => {
    monitor.recordCycleFailure('RPC timeout')
    const status = monitor.getStatus()
    expect(status.cyclesFailed).toBe(1)
    expect(status.lastError).toBe('RPC timeout')
  })

  it('tracks AI and RPC status', () => {
    monitor.setAiStatus('degraded')
    monitor.setRpcStatus('failover')
    const status = monitor.getStatus()
    expect(status.aiLayerStatus).toBe('degraded')
    expect(status.rpcStatus).toBe('failover')
  })

  it('defaults to healthy status', () => {
    const status = monitor.getStatus()
    expect(status.aiLayerStatus).toBe('available')
    expect(status.rpcStatus).toBe('healthy')
  })
})
