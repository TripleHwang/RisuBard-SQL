type Render<Value> = (value: Value) => void | Promise<void>
type RequestFrame = (callback: FrameRequestCallback) => number
type CancelFrame = (handle: number) => void

function browserlessRequestFrame(callback: FrameRequestCallback): number {
    return setTimeout(() => callback(Date.now()), 0) as unknown as number
}

function browserlessCancelFrame(handle: number): void {
    clearTimeout(handle)
}

/**
 * Coalesces a fast stream into one display update per animation frame.
 * The final caller can use flushNow() to await the exact terminal update.
 */
export class StreamRenderScheduler<Value> {
    private pending: Value | undefined
    private hasPending = false
    private frame: number | null = null
    private running: Promise<void> | null = null
    private cancelled = false
    private error: unknown = null

    constructor(
        private readonly render: Render<Value>,
        private readonly requestFrame: RequestFrame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : browserlessRequestFrame,
        private readonly cancelFrame: CancelFrame = typeof cancelAnimationFrame === 'function'
            ? cancelAnimationFrame
            : browserlessCancelFrame,
    ) {}

    schedule(value: Value): void {
        if (this.cancelled) return
        this.pending = value
        this.hasPending = true
        this.requestNextFrame()
    }

    /** Wait for in-flight work, then apply every pending terminal value. */
    async flushNow(): Promise<void> {
        if (this.error !== null) throw this.error
        if (this.cancelled) return
        this.clearFrame()
        while (true) {
            await this.running
            this.clearFrame()
            if (this.error !== null) throw this.error
            if (!this.hasPending || this.cancelled) return
            const value = this.takePending()
            await this.render(value)
        }
    }

    /** Discards queued work and prevents later scheduling. */
    cancel(): void {
        this.cancelled = true
        this.pending = undefined
        this.hasPending = false
        this.clearFrame()
    }

    /** Cancels queued work and waits until a current renderer has settled. */
    async cancelAndWait(): Promise<void> {
        this.cancel()
        await this.running
    }

    private requestNextFrame(): void {
        if (this.cancelled || this.frame !== null || this.running !== null || !this.hasPending) return
        this.frame = this.requestFrame(() => {
            this.frame = null
            this.runFrame()
        })
    }

    private runFrame(): void {
        if (this.cancelled || !this.hasPending || this.running !== null) return
        const value = this.takePending()
        this.running = Promise.resolve().then(() => this.render(value)).catch((error) => {
            this.error ??= error
            this.cancel()
        }).finally(() => {
            this.running = null
            this.requestNextFrame()
        })
        void this.running
    }

    private takePending(): Value {
        this.hasPending = false
        return this.pending as Value
    }

    private clearFrame(): void {
        if (this.frame === null) return
        this.cancelFrame(this.frame)
        this.frame = null
    }
}
