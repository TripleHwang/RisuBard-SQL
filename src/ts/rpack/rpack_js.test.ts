import { describe, expect, it } from 'vitest'

class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    posted = 0
    pending: Array<{ id: number }> = []

    postMessage(message: { id: number }) {
        this.posted += 1
        this.pending.push(message)
    }

    complete(value: number) {
        const request = this.pending.shift()
        if (!request) throw new Error('No pending worker request')
        this.onmessage?.({
            data: {
                id: request.id,
                data: Uint8Array.of(value).buffer,
            },
        } as MessageEvent)
    }

    terminate() {}
}

describe('RPackDecoderPool', () => {
    it('keeps one core available for the UI and caps the worker count', async () => {
        const rpack = await import('./rpack_js.js') as Record<string, any>

        expect(rpack.getRPackWorkerCount).toBeTypeOf('function')
        expect(rpack.getRPackWorkerCount(1)).toBe(1)
        expect(rpack.getRPackWorkerCount(8)).toBe(7)
        expect(rpack.getRPackWorkerCount(32)).toBe(8)
    })

    it('decodes across reusable workers while preserving input order', async () => {
        const rpack = await import('./rpack_js.js') as Record<string, any>
        const workers: FakeWorker[] = []
        const pool = new rpack.RPackDecoderPool(3, () => {
            const worker = new FakeWorker()
            workers.push(worker)
            return worker
        })

        const resultPromise = pool.decodeAll([
            Uint8Array.of(1),
            Uint8Array.of(2),
            Uint8Array.of(3),
            Uint8Array.of(4),
        ])

        expect(workers.map(worker => worker.posted)).toEqual([1, 1, 1])
        workers[1].complete(20)
        expect(workers[1].posted).toBe(2)
        workers[0].complete(10)
        workers[2].complete(30)
        workers[1].complete(40)

        const result = await resultPromise
        expect(result.map((item: Uint8Array) => item[0])).toEqual([10, 20, 30, 40])
        pool.terminate()
    })
})
