import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')

describe('data import parallelism connections', () => {
    it('publishes backup and save-folder objects through asynchronous atomic KV replacement', () => {
        expect(server).toContain('await kvReplacePrefixesAsync(stagedKvEntries')
        expect(server).toContain('await kvReplaceAllAsync(entries)')
    })

    it('decompresses uploaded save-folder ZIPs through the worker-thread fflate API', () => {
        const route = server.slice(
            server.indexOf("app.post('/api/migrate/save-folder/upload'"),
            server.indexOf("app.post('/api/migrate/save-folder/cleanup/scan'"),
        )
        expect(route).toContain('fflate.unzip(')
        expect(route).not.toContain('unzipSync')
    })
})
