import { decodeRPack } from './rpack_js.js'

self.onmessage = async (event) => {
    const { id, data } = event.data
    try {
        const decoded = await decodeRPack(new Uint8Array(data))
        self.postMessage({ id, data: decoded.buffer }, [decoded.buffer])
    } catch (error) {
        self.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}
