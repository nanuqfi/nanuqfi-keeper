import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Keeper } from './keeper'
import { HealthMonitor } from './health/monitor'
import type { KeeperConfig } from './config'

const mockConfig: KeeperConfig = {
  rpcUrls: ['http://localhost:8899'],
  keeperKeypairPath: '/tmp/test-keypair.json',
  cycleIntervalMs: 100,
  aiCycleIntervalMs: 1000,
  aiApiKey: 'test-key',
  aiModel: 'claude-sonnet-4-6',
  aiMaxCallsPerHour: 10,
  aiBudgetPerDay: 5,
}

describe('Keeper', () => {
  let keeper: Keeper
  let monitor: HealthMonitor

  beforeEach(() => {
    monitor = new HealthMonitor()
    keeper = new Keeper({ config: mockConfig, monitor })
  })

  afterEach(() => {
    keeper.stop()
  })

  it('runs a cycle and records success', async () => {
    await keeper.runCycle()
    const status = monitor.getStatus()
    expect(status.cyclesCompleted).toBe(1)
    expect(status.lastCycleTimestamp).toBeGreaterThan(0)
  })

  it('records multiple cycles', async () => {
    await keeper.runCycle()
    await keeper.runCycle()
    await keeper.runCycle()
    expect(monitor.getStatus().cyclesCompleted).toBe(3)
  })

  it('stops cleanly', () => {
    keeper.stop()
    // No error, no pending timers
  })

  it('boot fails when all RPCs are down', async () => {
    // Mock fetch to always fail
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))

    try {
      await expect(keeper.boot()).rejects.toThrow('All RPC endpoints unreachable')
      expect(monitor.getStatus().rpcStatus).toBe('down')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('boot succeeds when RPC is healthy', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })

    try {
      await keeper.boot()
      expect(monitor.getStatus().rpcStatus).toBe('healthy')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
