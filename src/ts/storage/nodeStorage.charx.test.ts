import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

import { NodeStorage } from './nodeStorage'

class FakeXhr {
    static instances: FakeXhr[] = []
    method = ''
    url = ''
    headers: Record<string, string> = {}
    sentBody: unknown
    status = 200
    responseText = ''
    upload: { onprogress?: (event: ProgressEvent) => void, onload?: () => void } = {}
    onprogress?: () => void
    onerror?: () => void
    onabort?: () => void
    onload?: () => void

    constructor() { FakeXhr.instances.push(this) }
    open(method: string, url: string) { this.method = method; this.url = url }
    setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value }
    send(body: unknown) { this.sentBody = body }
    emitUpload(loaded: number, total: number) {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent)
    }
    emitResponse(text: string) { this.responseText += text; this.onprogress?.() }
    finish(status = 200) { this.status = status; this.onload?.() }
}

const unavailable = 'Server-assisted CharX import is unavailable. Update the RisuVault server and try again.'

describe('NodeStorage.importCharX', () => {
    const originalXhr = globalThis.XMLHttpRequest

    afterEach(() => {
        globalThis.XMLHttpRequest = originalXhr
        FakeXhr.instances = []
    })

    function begin() {
        globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
        const storage = new NodeStorage()
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
        const blob = new Blob(['raw CharX archive'])
        return { blob, promise: storage.importCharX(blob), xhr: () => FakeXhr.instances.at(-1)! }
    }

    it('sends the original blob with auth headers and streams progress plus result', async () => {
        globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
        const storage = new NodeStorage()
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
        const blob = new Blob(['raw CharX archive'])
        const progress: unknown[] = []
        const promise = storage.importCharX(blob, value => progress.push(value))
        await Promise.resolve()
        const xhr = FakeXhr.instances[0]

        expect(xhr.method).toBe('POST')
        expect(xhr.url).toBe('/api/charx/import')
        expect(xhr.headers['content-type']).toBe('application/x-risu-charx')
        expect(xhr.headers.accept).toBe('application/x-ndjson')
        expect(xhr.headers['risu-auth']).toBe('test-auth')
        expect(xhr.headers['x-session-id']).toBeTruthy()
        expect(xhr.sentBody).toBe(blob)

        xhr.emitUpload(5, 10)
        xhr.upload.onload?.()
        xhr.emitResponse('{"type":"progress","completed":1,')
        xhr.emitResponse('"total":2}\n{"type":"done","result":{"card":{"spec":"chara_card_v3"},"moduleBase64":null,"assets":{"assets/avatar.png":"assets/hash.png"},"excludedFiles":[],"warnings":[]}}')
        xhr.finish()

        const result = await promise
        expect(progress).toEqual([
            { phase: 'uploading', loaded: 5, total: 10 },
            { phase: 'processing', completed: 1, total: 2 },
        ])
        expect(result.assets).toEqual({ 'assets/avatar.png': 'assets/hash.png' })
    })

    it.each([404, 501])('reports an actionable unavailable message for HTTP %s', async status => {
        const { promise, xhr } = begin()
        await Promise.resolve()
        xhr().emitResponse('{"error":"missing"}')
        xhr().finish(status)
        await expect(promise).rejects.toThrow(unavailable)
    })

    it('surfaces HTTP JSON errors', async () => {
        const { promise, xhr } = begin()
        await Promise.resolve()
        xhr().emitResponse('{"error":"invalid CharX"}')
        xhr().finish(400)
        await expect(promise).rejects.toThrow('invalid CharX')
    })

    it('surfaces NDJSON errors and ignores malformed or unknown events', async () => {
        const { promise, xhr } = begin()
        await Promise.resolve()
        xhr().emitResponse('not json\n{"type":"heartbeat"}\n{"type":"mystery"}\n{"type":"error","code":"INVALID_CHARX","message":"invalid CharX"}\n')
        xhr().finish()
        await expect(promise).rejects.toThrow('invalid CharX')
    })

    it('rejects a successful response without a final result', async () => {
        const { promise, xhr } = begin()
        await Promise.resolve()
        xhr().emitResponse('{"type":"progress","completed":1,"total":2}\n')
        xhr().finish()
        await expect(promise).rejects.toThrow('CharX import: no result received')
    })

    it('rejects network and aborted requests', async () => {
        const network = begin()
        await Promise.resolve()
        network.xhr().onerror?.()
        await expect(network.promise).rejects.toThrow('CharX import request failed')

        const aborted = begin()
        await Promise.resolve()
        aborted.xhr().onabort?.()
        await expect(aborted.promise).rejects.toThrow('CharX import request aborted')
    })
})
