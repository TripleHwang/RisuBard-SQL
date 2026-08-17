import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
    atomicWriteFile,
    atomicWriteJson,
    commitTransaction,
    moveToTrash,
    readVerifiedJson,
    recoverTransactions,
} = require('./file-store.cjs')
const { resolveDataRoot } = require('./data-root.cjs')

const roots: string[] = []

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-file-store-'))
    roots.push(root)
    return root
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveDataRoot', () => {
    it('uses an explicit absolute user-data root independently from the app directory', () => {
        const root = path.resolve(tempRoot(), 'user-data')
        expect(resolveDataRoot({ env: { RISUBARD_DATA_ROOT: root }, cwd: 'C:\\app' })).toBe(root)
    })

    it('rejects shared Android storage as canonical Termux data', () => {
        expect(() => resolveDataRoot({
            env: { RISUBARD_DATA_ROOT: '/sdcard/RisuBard', PREFIX: '/data/data/com.termux/files/usr' },
            cwd: '/data/data/com.termux/files/home/app',
            platform: 'linux',
        })).toThrow(/shared Android storage/i)
    })
})

describe('crash-safe canonical writes', () => {
    it('validates bytes, publishes atomically, and preserves the previous revision', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'settings/app.json', Buffer.from('{"revision":1}'), {
            validate: (bytes: Buffer) => JSON.parse(bytes.toString('utf8')).revision === 1,
        })
        atomicWriteFile(root, 'settings/app.json', Buffer.from('{"revision":2}'), {
            validate: (bytes: Buffer) => JSON.parse(bytes.toString('utf8')).revision === 2,
        })

        expect(fs.readFileSync(path.join(root, 'settings/app.json'), 'utf8')).toBe('{"revision":2}')
        expect(fs.readFileSync(path.join(root, 'settings/app.json.bak'), 'utf8')).toBe('{"revision":1}')
        expect(fs.readdirSync(path.join(root, 'settings')).some(name => name.endsWith('.tmp'))).toBe(false)
    })

    it('rejects invalid content without replacing the last good revision', () => {
        const root = tempRoot()
        atomicWriteJson(root, 'settings/app.json', { schemaVersion: 1, value: 'safe' })
        expect(() => atomicWriteFile(root, 'settings/app.json', Buffer.from('{}'), {
            validate: () => false,
        })).toThrow(/validation/i)
        expect(readVerifiedJson(root, 'settings/app.json')).toEqual({ schemaVersion: 1, value: 'safe' })
    })
})

describe('journal recovery and trash', () => {
    it('finishes a prepared multi-file transaction after a simulated crash', () => {
        const root = tempRoot()
        expect(() => commitTransaction(root, [
            { path: 'settings/app.json', data: Buffer.from('{"ok":true}') },
            { path: 'presets/preset-1.json', data: Buffer.from('{"id":"preset-1"}') },
        ], { failAfterPublish: 1 })).toThrow(/simulated crash/i)

        recoverTransactions(root)
        expect(JSON.parse(fs.readFileSync(path.join(root, 'settings/app.json'), 'utf8'))).toEqual({ ok: true })
        expect(JSON.parse(fs.readFileSync(path.join(root, 'presets/preset-1.json'), 'utf8'))).toEqual({ id: 'preset-1' })
        expect(fs.readdirSync(path.join(root, '.journal'))).toHaveLength(0)
    })

    it('moves deleted canonical data to trash with recoverable bytes', () => {
        const root = tempRoot()
        atomicWriteFile(root, 'characters/char-1/metadata.json', Buffer.from('character'))
        const trashed = moveToTrash(root, 'characters/char-1/metadata.json')
        expect(fs.existsSync(path.join(root, 'characters/char-1/metadata.json'))).toBe(false)
        expect(fs.readFileSync(trashed, 'utf8')).toBe('character')
        expect(trashed).toContain(`${path.sep}trash${path.sep}`)
    })
})
