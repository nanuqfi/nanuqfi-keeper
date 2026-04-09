export interface HealthStatus {
  uptime: number
  lastCycleTimestamp: number
  cyclesCompleted: number
  cyclesFailed: number
  aiLayerStatus: 'available' | 'degraded' | 'unavailable'
  rpcStatus: 'healthy' | 'failover' | 'down'
  lastError?: string
}

export class HealthMonitor {
  private startTime = Date.now()
  private _lastCycleTimestamp = 0
  private _cyclesCompleted = 0
  private _cyclesFailed = 0
  private _aiLayerStatus: HealthStatus['aiLayerStatus'] = 'available'
  private _rpcStatus: HealthStatus['rpcStatus'] = 'healthy'
  private _lastError?: string

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
  }

  recordCycleFailure(error: string): void {
    this._cyclesFailed++
    this._lastCycleTimestamp = Date.now()
    this._lastError = error
  }

  setAiStatus(status: HealthStatus['aiLayerStatus']): void {
    this._aiLayerStatus = status
  }

  setRpcStatus(status: HealthStatus['rpcStatus']): void {
    this._rpcStatus = status
  }
}
