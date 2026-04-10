import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const HEALTH_STATS_PATH = process.env.HEALTH_STATS_PATH ?? '/data/health-stats.json'

export interface HealthStatus {
  uptime: number
  lastCycleTimestamp: number
  cyclesCompleted: number
  cyclesFailed: number
  aiLayerStatus: 'available' | 'degraded' | 'unavailable'
  rpcStatus: 'healthy' | 'failover' | 'down'
  lastError?: string
}

interface PersistedStats {
  cyclesCompleted: number
  cyclesFailed: number
  lastCycleTimestamp: number
}

export class HealthMonitor {
  private startTime = Date.now()
  private _lastCycleTimestamp = 0
  private _cyclesCompleted = 0
  private _cyclesFailed = 0
  private _aiLayerStatus: HealthStatus['aiLayerStatus'] = 'available'
  private _rpcStatus: HealthStatus['rpcStatus'] = 'healthy'
  private _lastError?: string

  constructor() {
    this.loadStats()
  }

  private loadStats(): void {
    try {
      const raw = readFileSync(HEALTH_STATS_PATH, 'utf-8')
      const stats: PersistedStats = JSON.parse(raw)
      this._cyclesCompleted = stats.cyclesCompleted ?? 0
      this._cyclesFailed = stats.cyclesFailed ?? 0
      this._lastCycleTimestamp = stats.lastCycleTimestamp ?? 0
      console.log(`[Health] Restored stats: ${this._cyclesCompleted} completed, ${this._cyclesFailed} failed`)
    } catch (err) {
      console.warn('[Health] Failed to load persisted stats:', err)
      // First boot or corrupted file — start fresh
    }
  }

  private saveStats(): void {
    try {
      const dir = HEALTH_STATS_PATH.substring(0, HEALTH_STATS_PATH.lastIndexOf('/'))
      if (dir) mkdirSync(dir, { recursive: true })
      const stats: PersistedStats = {
        cyclesCompleted: this._cyclesCompleted,
        cyclesFailed: this._cyclesFailed,
        lastCycleTimestamp: this._lastCycleTimestamp,
      }
      writeFileSync(HEALTH_STATS_PATH, JSON.stringify(stats))
    } catch (err) {
      console.error('[Health] Failed to persist stats:', err instanceof Error ? err.message : err)
    }
  }

  getStatus(): HealthStatus {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      lastCycleTimestamp: this._lastCycleTimestamp,
      cyclesCompleted: this._cyclesCompleted,
      cyclesFailed: this._cyclesFailed,
      aiLayerStatus: this._aiLayerStatus,
      rpcStatus: this._rpcStatus,
      lastError: this._lastError,
    }
  }

  recordCycleSuccess(): void {
    this._cyclesCompleted++
    this._lastCycleTimestamp = Date.now()
    this.saveStats()
  }

  recordCycleFailure(error: string): void {
    this._cyclesFailed++
    this._lastCycleTimestamp = Date.now()
    this._lastError = error
    this.saveStats()
  }

  setAiStatus(status: HealthStatus['aiLayerStatus']): void {
    this._aiLayerStatus = status
  }

  setRpcStatus(status: HealthStatus['rpcStatus']): void {
    this._rpcStatus = status
  }
}
