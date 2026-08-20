import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createFileKv } = require('./file-kv.cjs')

const roots: string[] = []
function root() {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-kv-'))
    roots.push(value)
    return value
}
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })))

describe('file-native KV compatibility projection', () => {
    it('round-trips binary values and persists only a small manifest plus content objects', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        expect(store).not.toHaveProperty('dataRoot')
        store.kvSet('database/database.bin', Buffer.from([0, 1, 2, 255]))

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet('database/database.bin')).toEqual(Buffer.from([0, 1, 2, 255]))
        expect(reopened.kvList()).toEqual(['database/database.bin'])
        expect(fs.existsSync(path.join(dataRoot, 'risuai.db'))).toBe(false)
        expect(fs.readdirSync(path.join(dataRoot, 'kv', 'objects'))).toHaveLength(1)
    })

    it('copies snapshots by content reference and keeps them stable after live data changes', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('database/database.bin', Buffer.from('revision-1'))
        store.kvCopyValue('database/database.bin', 'database/dbbackup-1.bin')
        store.kvSet('database/database.bin', Buffer.from('revision-2'))

        expect(store.kvGet('database/dbbackup-1.bin')?.toString()).toBe('revision-1')
        expect(store.kvGet('database/database.bin')?.toString()).toBe('revision-2')
        expect(store.snapshotFootprint('database/dbbackup-1.bin')).toBe(Buffer.byteLength('revision-1'))
    })

    it('supports prefix listing, sizes, deletion, and reclaiming unreferenced objects', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/a', Buffer.from('aaa'))
        store.kvSet('assets/b', Buffer.from('bbbb'))
        store.kvSet('settings/c', Buffer.from('cc'))

        expect(store.kvListWithSizes('assets/')).toEqual([
            { key: 'assets/a', size: 3 },
            { key: 'assets/b', size: 4 },
        ])
        store.kvDelPrefix('assets/')
        expect(store.kvList()).toEqual(['settings/c'])
        expect(store.reclaimableChunkBytes()).toBe(7)
        expect(store.gcChunks()).toBe(2)
    })

    it('imports the legacy hexadecimal save-folder layout once without overwriting canonical values', () => {
        const dataRoot = root()
        const key = 'database/database.bin'
        fs.writeFileSync(path.join(dataRoot, Buffer.from(key).toString('hex')), Buffer.from('legacy'))
        const store = createFileKv({ dataRoot })
        expect(store.kvGet(key)?.toString()).toBe('legacy')

        fs.writeFileSync(path.join(dataRoot, Buffer.from(key).toString('hex')), Buffer.from('changed-legacy'))
        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet(key)?.toString()).toBe('legacy')
    })
})
