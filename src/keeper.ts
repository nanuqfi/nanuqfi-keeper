import type { KeeperConfig } from './config'
import { HealthMonitor } from './health/monitor'
import { initDriftClient, checkDriftHealth, DriftDataCache } from './drift'
import type { DriftClient } from '@drift-labs/sdk'

export interface KeeperDeps {
  config: KeeperConfig
  monitor: HealthMonitor
  driftClient?: DriftClient
  dataCache?: DriftDataCache
}

export class Keeper {
  private readonly config: KeeperConfig
  private readonly monitor: HealthMonitor
  private driftClient?: DriftClient
  private dataCache?: DriftDataCache
  private running = false
  private cycleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: KeeperDeps) {
    this.config = deps.config
    this.monitor = deps.monitor
    this.driftClient = deps.driftClient
    this.dataCache = deps.dataCache
  }

  async boot(): Promise<void> {
    // 1. Verify RPC connectivity
    await this.checkRpc()

    // 2. Initialize Drift SDK if config present and not already injected
    if (this.config.drift?.rpcUrl && !this.driftClient) {
      this.driftClient = await initDriftClient(this.config.drift)
      this.dataCache = new DriftDataCache()
    }
  }

  async start(): Promise<void> {
    this.running = true
    await this.boot()
    this.scheduleNextCycle()
  }

  stop(): void {
    this.running = false
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer)
      this.cycleTimer = null
    }
  }

  private scheduleNextCycle(): void {
    if (!this.running) return
    this.cycleTimer = setTimeout(async () => {
      await this.runCycle()
      this.scheduleNextCycle()
    }, this.config.cycleIntervalMs)
  }

  async runCycle(): Promise<void> {
    const cycleTimeout = 60_000 // 60s max per cycle
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), cycleTimeout)

    try {
      // Check Drift subscription health if connected
      if (this.driftClient && !checkDriftHealth(this.driftClient)) {
        this.monitor.recordCycleFailure('Drift subscription unhealthy')
        return
      }

      // 1. Reconcile on-chain state
      // 2. Run algorithm engine
      // 3. Check AI triggers -> run AI if needed
      // 4. Propose rebalance (if needed)
      // 5. Write heartbeat

      // Placeholder — real implementation connects engine + AI + on-chain
      this.monitor.recordCycleSuccess()
    } catch (error) {
      if (controller.signal.aborted) {
        this.monitor.recordCycleFailure('Cycle timeout (60s)')
      } else {
        this.monitor.recordCycleFailure(
          error instanceof Error ? error.message : 'Unknown error'
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async checkRpc(): Promise<void> {
    for (const url of this.config.rpcUrls) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5_000)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (res.ok) {
          this.monitor.setRpcStatus('healthy')
          return
        }
      } catch {
        // Try next RPC
      }
    }
    this.monitor.setRpcStatus('down')
    throw new Error('All RPC endpoints unreachable')
  }
}
