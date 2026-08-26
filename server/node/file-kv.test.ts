import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createFileKv } = require('./file-kv.cjs')
const { atomicWriteJson } = require('./file-store.cjs')

const roots: string[] = []
function root() {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-kv-'))
    roots.push(value)
    return value
}
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })))

async function waitForStagedSourceConsumption(sourcePath: string) {
    while (fs.existsSync(sourcePath)) await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
}

describe('file-native KV compatibility projection', () => {
    it('adds staged files without replacing existing assets and persists the batch', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const firstPath = path.join(stagingRoot, 'first.bin')
        const secondPath = path.join(stagingRoot, 'second.bin')
        fs.writeFileSync(firstPath, Buffer.from('first'))
        fs.writeFileSync(secondPath, Buffer.from('second'))
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/existing', Buffer.from('existing'))

        await store.kvSetManyFromFilesAsync([
            { key: 'assets/first', sourcePath: firstPath },
            { key: 'assets/second', sourcePath: secondPath },
        ])

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList('assets/')).toEqual(['assets/existing', 'assets/first', 'assets/second'])
        expect(reopened.kvGet('assets/existing')?.toString()).toBe('existing')
        expect(reopened.kvGet('assets/first')?.toString()).toBe('first')
        expect(reopened.kvGet('assets/second')?.toString()).toBe('second')
    })

    it('does not publish any staged-file keys when one source cannot be prepared', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const validPath = path.join(stagingRoot, 'valid.bin')
        fs.writeFileSync(validPath, Buffer.from('valid'))
        const store = createFileKv({ dataRoot })

        await expect(store.kvSetManyFromFilesAsync([
            { key: 'assets/valid', sourcePath: validPath },
            { key: 'assets/missing', sourcePath: path.join(stagingRoot, 'missing.bin') },
        ])).rejects.toThrow()

        expect(store.kvList('assets/')).toEqual([])
        expect(createFileKv({ dataRoot }).kvList('assets/')).toEqual([])
    })

    it('keeps the previous manifest if staged-file batch publication fails', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'new.bin')
        fs.writeFileSync(sourcePath, Buffer.from('new'))
        createFileKv({ dataRoot }).kvSet('assets/existing', Buffer.from('existing'))
        const store = createFileKv({
            dataRoot,
            manifestWriter: async () => {
                await Promise.resolve()
                throw new Error('manifest write failed')
            },
        })

        await expect(store.kvSetManyFromFilesAsync([
            { key: 'assets/new', sourcePath },
        ])).rejects.toThrow('manifest write failed')

        expect(store.kvList('assets/')).toEqual(['assets/existing'])
        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList('assets/')).toEqual(['assets/existing'])
        expect(reopened.kvGet('assets/existing')?.toString()).toBe('existing')
    })

    it('serializes overlapping staged-file manifest commits without losing either batch', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const firstPath = path.join(stagingRoot, 'first.bin')
        const secondPath = path.join(stagingRoot, 'second.bin')
        fs.writeFileSync(firstPath, Buffer.from('first'))
        fs.writeFileSync(secondPath, Buffer.from('second'))
        let releaseFirstWriter!: () => void
        let firstWriterStarted!: () => void
        const firstWriterStartedPromise = new Promise<void>(resolve => { firstWriterStarted = resolve })
        const firstWriterRelease = new Promise<void>(resolve => { releaseFirstWriter = resolve })
        let writes = 0
        const store = createFileKv({
            dataRoot,
            manifestWriter: async next => {
                if (writes++ === 0) {
                    firstWriterStarted()
                    await firstWriterRelease
                }
                atomicWriteJson(dataRoot, 'kv/manifest.json', next)
            },
        })

        const first = store.kvSetManyFromFilesAsync([{ key: 'assets/first', sourcePath: firstPath }])
        await firstWriterStartedPromise
        const second = store.kvSetManyFromFilesAsync([{ key: 'assets/second', sourcePath: secondPath }])
        await waitForStagedSourceConsumption(secondPath)
        releaseFirstWriter()
        await Promise.all([first, second])

        expect(store.kvList('assets/')).toEqual(['assets/first', 'assets/second'])
        expect(createFileKv({ dataRoot }).kvList('assets/')).toEqual(['assets/first', 'assets/second'])
    })

    it('keeps an ordinary manifest mutation made during a staged-file commit', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'staged.bin')
        fs.writeFileSync(sourcePath, Buffer.from('staged'))
        let releaseWriter!: () => void
        let writerStarted!: () => void
        const writerStartedPromise = new Promise<void>(resolve => { writerStarted = resolve })
        const writerRelease = new Promise<void>(resolve => { releaseWriter = resolve })
        const store = createFileKv({
            dataRoot,
            manifestWriter: async next => {
                writerStarted()
                await writerRelease
                atomicWriteJson(dataRoot, 'kv/manifest.json', next)
            },
        })

        const staged = store.kvSetManyFromFilesAsync([{ key: 'assets/staged', sourcePath }])
        await writerStartedPromise
        store.kvSet('settings/during-staged-write', Buffer.from('ordinary'))
        releaseWriter()
        await staged

        expect(store.kvList()).toEqual(['assets/staged', 'settings/during-staged-write'])
        expect(createFileKv({ dataRoot }).kvList()).toEqual(['assets/staged', 'settings/during-staged-write'])
    })

    it('keeps an ordinary deletion and continues the staged queue after a failed staged commit', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const failedPath = path.join(stagingRoot, 'failed.bin')
        const laterPath = path.join(stagingRoot, 'later.bin')
        fs.writeFileSync(failedPath, Buffer.from('failed'))
        fs.writeFileSync(laterPath, Buffer.from('later'))
        let releaseFirstWriter!: () => void
        let firstWriterStarted!: () => void
        const firstWriterStartedPromise = new Promise<void>(resolve => { firstWriterStarted = resolve })
        const firstWriterRelease = new Promise<void>(resolve => { releaseFirstWriter = resolve })
        let writes = 0
        const store = createFileKv({
            dataRoot,
            manifestWriter: async next => {
                if (writes++ === 0) {
                    firstWriterStarted()
                    await firstWriterRelease
                    throw new Error('manifest write failed')
                }
                atomicWriteJson(dataRoot, 'kv/manifest.json', next)
            },
        })
        store.kvSet('assets/remove-me', Buffer.from('remove'))

        const failed = store.kvSetManyFromFilesAsync([{ key: 'assets/failed', sourcePath: failedPath }])
        await firstWriterStartedPromise
        store.kvDel('assets/remove-me')
        const later = store.kvSetManyFromFilesAsync([{ key: 'assets/later', sourcePath: laterPath }])
        await waitForStagedSourceConsumption(laterPath)
        releaseFirstWriter()
        await expect(failed).rejects.toThrow('manifest write failed')
        await later

        expect(store.kvList()).toEqual(['assets/later'])
        expect(createFileKv({ dataRoot }).kvList()).toEqual(['assets/later'])
    })

    it('continues queued staged-file commits after a manifest write failure', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const failedPath = path.join(stagingRoot, 'failed.bin')
        const laterPath = path.join(stagingRoot, 'later.bin')
        fs.writeFileSync(failedPath, Buffer.from('failed'))
        fs.writeFileSync(laterPath, Buffer.from('later'))
        let rejectFirstWriter!: () => void
        let firstWriterStarted!: () => void
        const firstWriterStartedPromise = new Promise<void>(resolve => { firstWriterStarted = resolve })
        const firstWriterRelease = new Promise<void>(resolve => { rejectFirstWriter = resolve })
        let writes = 0
        const store = createFileKv({
            dataRoot,
            manifestWriter: async next => {
                if (writes++ === 0) {
                    firstWriterStarted()
                    await firstWriterRelease
                    throw new Error('manifest write failed')
                }
                atomicWriteJson(dataRoot, 'kv/manifest.json', next)
            },
        })

        const failed = store.kvSetManyFromFilesAsync([{ key: 'assets/failed', sourcePath: failedPath }])
        await firstWriterStartedPromise
        const later = store.kvSetManyFromFilesAsync([{ key: 'assets/later', sourcePath: laterPath }])
        await waitForStagedSourceConsumption(laterPath)
        rejectFirstWriter()
        await expect(failed).rejects.toThrow('manifest write failed')
        await later

        expect(store.kvList('assets/')).toEqual(['assets/later'])
        expect(createFileKv({ dataRoot }).kvList('assets/')).toEqual(['assets/later'])
    })

    it('publishes replacement values from staged files without loading them into entry buffers', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'large.bin')
        fs.writeFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024, 0x6b))
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/old', Buffer.from('old'))

        await store.kvReplacePrefixesFromFilesAsync([
            { key: 'assets/large', sourcePath },
        ], ['assets/'])

        expect(store.kvList('assets/')).toEqual(['assets/large'])
        expect(store.kvSize('assets/large')).toBe(2 * 1024 * 1024)
        expect(store.kvGet('assets/large')).toEqual(Buffer.alloc(2 * 1024 * 1024, 0x6b))
    })

    it('prepares replacement objects asynchronously before publishing one manifest', async () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })

        await store.kvReplaceAllAsync([
            { key: 'database/database.bin', value: Buffer.from('database') },
            { key: 'assets/a', value: Buffer.from('asset-a') },
        ])

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList()).toEqual(['assets/a', 'database/database.bin'])
        expect(reopened.kvGet('assets/a')?.toString()).toBe('asset-a')
    })

    it('replaces the complete manifest from staged files only after every source prepares', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const databasePath = path.join(stagingRoot, 'database.bin')
        const assetPath = path.join(stagingRoot, 'asset.bin')
        fs.writeFileSync(databasePath, Buffer.from('new-database'))
        fs.writeFileSync(assetPath, Buffer.from('new-asset'))
        const store = createFileKv({ dataRoot })
        store.kvSet('database/database.bin', Buffer.from('old-database'))
        store.kvSet('assets/old.png', Buffer.from('old-asset'))

        await store.kvReplaceAllFromFilesAsync([
            { key: 'database/database.bin', sourcePath: databasePath },
            { key: 'assets/new.png', sourcePath: assetPath },
        ])

        expect(store.kvList()).toEqual(['assets/new.png', 'database/database.bin'])
        expect(store.kvGet('database/database.bin')?.toString()).toBe('new-database')
        expect(store.kvGet('assets/new.png')?.toString()).toBe('new-asset')
        expect(fs.existsSync(databasePath)).toBe(false)
        expect(fs.existsSync(assetPath)).toBe(false)
    })

    it('preserves the old manifest when a full staged replacement cannot prepare every source', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const validPath = path.join(stagingRoot, 'valid.bin')
        fs.writeFileSync(validPath, Buffer.from('replacement'))
        const store = createFileKv({ dataRoot, objectWriteConcurrency: 1 })
        store.kvSet('database/database.bin', Buffer.from('old-database'))

        await expect(store.kvReplaceAllFromFilesAsync([
            { key: 'assets/missing.png', sourcePath: path.join(stagingRoot, 'missing.bin') },
            { key: 'assets/valid.png', sourcePath: validPath },
        ])).rejects.toThrow()

        expect(store.kvList()).toEqual(['database/database.bin'])
        expect(store.kvGet('database/database.bin')?.toString()).toBe('old-database')
        // Staged paths are transferred to the importer as each independent prepare succeeds,
        // even if a later complete-manifest publish is rejected.
        expect(fs.existsSync(validPath)).toBe(false)
    })

    it('rejects duplicate replacement keys and ambiguous reused source paths before consuming them', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'input.bin')
        fs.writeFileSync(sourcePath, Buffer.from('input'))
        const store = createFileKv({ dataRoot })

        await expect(store.kvReplaceAllFromFilesAsync([
            { key: 'assets/a.png', sourcePath },
            { key: 'assets/a.png', sourcePath: path.join(stagingRoot, 'other.bin') },
        ])).rejects.toThrow(/duplicate.*key/i)
        expect(fs.existsSync(sourcePath)).toBe(true)

        await expect(store.kvReplaceAllFromFilesAsync([
            { key: 'assets/a.png', sourcePath },
            { key: 'assets/b.png', sourcePath },
        ])).rejects.toThrow(/source path/i)
        expect(fs.existsSync(sourcePath)).toBe(true)
    })

    it('replaces the complete manifest with an empty staged set', async () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('database/database.bin', Buffer.from('old-database'))

        await store.kvReplaceAllFromFilesAsync([])

        expect(store.kvList()).toEqual([])
        expect(createFileKv({ dataRoot }).kvList()).toEqual([])
    })

    it('preserves the complete old manifest if its replacement write fails', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'replacement.bin')
        fs.writeFileSync(sourcePath, Buffer.from('replacement'))
        createFileKv({ dataRoot }).kvSet('database/database.bin', Buffer.from('old-database'))
        const store = createFileKv({
            dataRoot,
            manifestWriter: async () => { throw new Error('manifest write failed') },
        })

        await expect(store.kvReplaceAllFromFilesAsync([
            { key: 'database/database.bin', sourcePath },
        ])).rejects.toThrow('manifest write failed')

        expect(store.kvList()).toEqual(['database/database.bin'])
        expect(store.kvGet('database/database.bin')?.toString()).toBe('old-database')
        expect(createFileKv({ dataRoot }).kvGet('database/database.bin')?.toString()).toBe('old-database')
    })

    it('keeps prepared replacement objects out of GC until their queued manifest commits', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'replacement.bin')
        fs.writeFileSync(sourcePath, Buffer.from('replacement'))
        let store: ReturnType<typeof createFileKv>
        store = createFileKv({
            dataRoot,
            manifestWriter: async next => {
                expect(store.gcChunks()).toEqual({ count: 0, bytes: 0 })
                atomicWriteJson(dataRoot, 'kv/manifest.json', next)
            },
        })

        await store.kvReplaceAllFromFilesAsync([
            { key: 'database/database.bin', sourcePath },
        ])

        expect(store.kvGet('database/database.bin')?.toString()).toBe('replacement')
    })

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
        expect(store.objectStoreBytes()).toBe(9)
        store.kvDelPrefix('assets/')
        expect(store.kvList()).toEqual(['settings/c'])
        expect(store.reclaimableChunkBytes()).toBe(7)
        expect(store.gcChunks()).toEqual({ count: 2, bytes: 7 })
        expect(store.objectStoreBytes()).toBe(2)
        expect(fs.existsSync(path.join(dataRoot, 'trash'))).toBe(false)
    })

    it('keeps recent unreachable objects during grace-period cleanup', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        const objectsDir = path.join(dataRoot, 'kv', 'objects')

        const oldValue = Buffer.from('old-orphan')
        store.kvSet('assets/old', oldValue)
        const oldObject = fs.readdirSync(objectsDir)[0]
        store.kvSet('assets/old', Buffer.from('current-old'))

        const beforeRecent = new Set(fs.readdirSync(objectsDir))
        const recentValue = Buffer.from('recent-orphan')
        store.kvSet('assets/recent', recentValue)
        const recentObject = fs.readdirSync(objectsDir).find(name => !beforeRecent.has(name))!
        store.kvSet('assets/recent', Buffer.from('current-recent'))

        const now = Date.now()
        fs.utimesSync(path.join(objectsDir, oldObject), new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000))
        fs.utimesSync(path.join(objectsDir, recentObject), new Date(now - 30 * 60 * 1000), new Date(now - 30 * 60 * 1000))

        expect(store.gcChunks({ minAgeMs: 60 * 60 * 1000, now })).toEqual({
            count: 1,
            bytes: oldValue.length,
        })
        expect(fs.existsSync(path.join(objectsDir, oldObject))).toBe(false)
        expect(fs.existsSync(path.join(objectsDir, recentObject))).toBe(true)
    })

    it('limits automatic cleanup work to the requested batch size', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/a', Buffer.from('old-a'))
        store.kvSet('assets/a', Buffer.from('current-a'))
        store.kvSet('assets/b', Buffer.from('old-b'))
        store.kvSet('assets/b', Buffer.from('current-b'))

        expect(store.reclaimableChunkBytes()).toBe(10)
        expect(store.gcChunks({ maxDeletes: 1 })).toEqual({ count: 1, bytes: 5 })
        expect(store.reclaimableChunkBytes()).toBe(5)
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
