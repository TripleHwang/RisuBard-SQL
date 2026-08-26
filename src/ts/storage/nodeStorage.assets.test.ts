import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))

import { NodeStorage } from './nodeStorage'

class FakeXhr {
    static instances: FakeXhr[] = []
    url = ''; headers: Record<string, string> = {}; sent: unknown; status = 200; responseText = ''
    onerror?: () => void; onabort?: () => void; onload?: () => void
    constructor() { FakeXhr.instances.push(this) }
    open(_method: string, url: string) { this.url = url }
    setRequestHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value }
    send(value: unknown) { this.sent = value }
    finish(status = 200) { this.status = status; this.onload?.() }
}

describe('NodeStorage streamed asset writes', () => {
    const originalXhr = globalThis.XMLHttpRequest
    afterEach(() => { globalThis.XMLHttpRequest = originalXhr; FakeXhr.instances = [] })
    it('sends the supplied Blob unchanged rather than JSON/base64', async () => {
        globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
        const storage = new NodeStorage(); vi.spyOn(storage, 'createAuth').mockResolvedValue('auth')
        const blob = new Blob(['pixels']); const pending = storage.setItemStreamed('assets/test.png', blob)
        await Promise.resolve(); const xhr = FakeXhr.instances[0]
        expect(xhr.url).toBe('/api/assets/upload'); expect(xhr.headers['x-risu-asset-key']).toBe('assets/test.png'); expect(xhr.sent).toBe(blob)
        xhr.finish(); await expect(pending).resolves.toBeUndefined()
    })
    it('uses raw uploads for large assets while preserving mixed duplicate-key order', async () => {
        const storage = new NodeStorage()
        const raw = vi.spyOn(storage, 'setItemStreamed').mockResolvedValue()
        const fetch = vi.spyOn(storage as any, 'authFetch').mockResolvedValue({ status: 200 } as Response)
        await storage.setItems([
            { key: 'assets/a.png', value: new Uint8Array([1]) },
            { key: 'assets/a.png', value: new Uint8Array(8 * 1024 * 1024 + 1) },
            { key: 'assets/a.png', value: new Uint8Array([2]) },
        ])
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(raw).toHaveBeenCalledWith('assets/a.png', expect.any(Uint8Array))
    })
})
