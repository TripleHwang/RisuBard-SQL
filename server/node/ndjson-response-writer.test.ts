import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

describe('bounded NDJSON response writer', () => {
    it('coalesces high-count progress and waits for backpressure drain', async () => {
        const { createNdjsonResponseWriter } = await import('./ndjson-response-writer.cjs')
        const response: any = new EventEmitter()
        response.writableEnded = false; response.destroyed = false
        const records: string[] = []
        response.write = vi.fn((record: string) => { records.push(record); return records.length !== 1 })
        const writer = createNdjsonResponseWriter(response, { throttleMs: 1000 })
        for (let i = 0; i < 10_000; i++) writer.progress({ type: 'progress', completed: i, total: 10_000 })
        const final = writer.final({ type: 'done', result: { imported: 1 } })
        await Promise.resolve()
        expect(response.write).toHaveBeenCalledTimes(1)
        response.emit('drain')
        await final
        const parsed = records.map(line => JSON.parse(line))
        expect(parsed).toEqual([
            { type: 'progress', completed: 9999, total: 10_000 },
            { type: 'done', result: { imported: 1 } },
        ])
    })

    it('drops repeated heartbeats while the response is backpressured', async () => {
        const { createNdjsonResponseWriter } = await import('./ndjson-response-writer.cjs')
        const response: any = new EventEmitter()
        response.writableEnded = false; response.destroyed = false
        response.write = vi.fn(() => false)
        const writer = createNdjsonResponseWriter(response)
        for (let i = 0; i < 1000; i++) writer.heartbeat()
        expect(response.write).toHaveBeenCalledTimes(1)
        response.emit('drain')
        await writer.flush()
    })
})
