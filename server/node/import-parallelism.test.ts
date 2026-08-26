import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')

describe('data import parallelism connections', () => {
    it('publishes backup and save-folder objects through asynchronous atomic KV replacement', () => {
        expect(server).toContain('await kvReplacePrefixesFromFilesAsync(stagedKvEntries')
        expect(server).toContain('await kvReplaceAllAsync(entries)')
    })

    it('keeps backup entries and canonical transaction inputs disk-backed', () => {
        expect(server).toContain('stageBackupEntries(dataSource')
        expect(server).toContain('sourcePath: path.join(canonicalStagingDir, relativePath)')
        expect(server).not.toContain('stagedKvEntries.push({ key: storageKey, value: Buffer.from(storageValue) })')
    })

    it('spools uploaded save-folder ZIPs and delegates bounded extraction', () => {
        const route = server.slice(
            server.indexOf("app.post('/api/migrate/save-folder/upload'"),
            server.indexOf("app.post('/api/migrate/save-folder/cleanup/scan'"),
        )
        expect(route).toContain('spoolSourceToOwnedFile')
        expect(route).toContain('importSaveFolderZip')
        expect(route).not.toMatch(/Buffer\.concat\(chunks\)|fflate\.unzip\(/)
    })

    it('keeps the CharX stream out of raw-body buffering and wires file-backed publication', () => {
        expect(server).toContain("req.path === '/api/backup/import' || req.path === '/api/charx/import'")
        expect(server).toContain("app.post('/api/charx/import'")
        expect(server).toContain('kvSetManyFromFilesAsync')
        const route = server.slice(server.indexOf("app.post('/api/charx/import'"), server.indexOf('// ── Server-side backup endpoints'))
        expect(route).not.toMatch(/charx[\s\S]{0,1500}Buffer\.concat\(chunks\)/i)
    })

    it('keeps the risum stream out of raw-body buffering and wires file-backed publication', () => {
        expect(server).toContain("req.path === '/api/backup/import' || req.path === '/api/charx/import' || req.path === '/api/risum/import'")
        expect(server).toContain("app.post('/api/risum/import'")
        const route = server.slice(server.indexOf("app.post('/api/risum/import'"), server.indexOf('// Pre-flight check: auth + size + disk space'))
        expect(route).toContain('kvSetManyFromFilesAsync')
        expect(route).not.toMatch(/risum[\s\S]{0,1600}Buffer\.concat\(chunks\)/i)
    })
})
