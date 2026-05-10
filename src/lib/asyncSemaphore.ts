/**
 * 异步信号量：最多同时 N 个 acquire 通过，其余排队（FIFO）。
 * 用于限制导出时成片下载并发，避免与段并行叠加导致 CDN/带宽被摊薄。
 */
export class AsyncSemaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    this.permits = Math.max(1, Math.floor(max))
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    if (this.waiters.length > 0) {
      const wake = this.waiters.shift()!
      wake()
    } else {
      this.permits++
    }
  }
}
