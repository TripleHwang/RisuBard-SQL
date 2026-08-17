import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarrativeSourceSnapshot } from '../../packages/risubard-core/src/sourceSnapshot'
import {
    createSourceSnapshotAdapter,
    resolveSourceSnapshotWorkspace,
} from './risubard-source-workspace'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(join(tmpdir(), 'risubard-source-'))
    directories.push(directory)
    return directory
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('source snapshot workspace', () => {
    it('atomically persists a cloned chat snapshot and reloads it after restart', async () => {
        const directory = await temporaryDirectory()
        const input = createNarrativeSourceSnapshot([{
            sourceId: 'character-description:char',
            kind: 'character-description',
            content: 'Original description',
        }])
        const first = createSourceSnapshotAdapter(directory)

        await first.saveSnapshot('char', 'chat', input)
        input.sources[0].content = 'Caller mutation'

        const restarted = createSourceSnapshotAdapter(directory)
        await expect(restarted.loadSnapshot('char', 'chat')).resolves.toEqual(
            createNarrativeSourceSnapshot([{
                sourceId: 'character-description:char',
                kind: 'character-description',
                content: 'Original description',
            }])
        )
    })

    it('returns null when no snapshot exists and rejects corrupted stored data', async () => {
        const directory = await temporaryDirectory()
        const adapter = createSourceSnapshotAdapter(directory)

        await expect(adapter.loadSnapshot('char', 'missing')).resolves.toBeNull()

        const workspace = resolveSourceSnapshotWorkspace(
            directory,
            'char',
            'broken'
        )
        await fs.mkdir(workspace.directory, { recursive: true })
        await fs.writeFile(workspace.sourceSnapshotFile, '{"schemaVersion":1}')

        await expect(adapter.loadSnapshot('char', 'broken')).rejects.toThrow()
    })

    it('reads snapshots and baselines saved under the legacy plain-ID path', async () => {
        const directory = await temporaryDirectory()
        const legacyDirectory = join(
            directory,
            'risubard',
            'characters',
            'char',
            'chats',
            'chat'
        )
        const snapshot = createNarrativeSourceSnapshot([{
            sourceId: 'source',
            kind: 'lorebook-entry',
            content: 'Legacy lore',
        }])
        await fs.mkdir(legacyDirectory, { recursive: true })
        await fs.writeFile(
            join(legacyDirectory, 'source-snapshot.json'),
            JSON.stringify(snapshot)
        )
        await fs.writeFile(
            join(legacyDirectory, 'baseline-summary.txt'),
            '<Thoughts>legacy reasoning</Thoughts>\nLegacy baseline'
        )

        const adapter = createSourceSnapshotAdapter(directory)
        await expect(adapter.loadSnapshot('char', 'chat')).resolves.toEqual(snapshot)
        await expect(adapter.loadBaseline('char', 'chat')).resolves.toBe(
            'Legacy baseline'
        )
    })

    it('confines encoded character and chat IDs to the workspace', async () => {
        const directory = await temporaryDirectory()
        const workspace = resolveSourceSnapshotWorkspace(
            directory,
            '../../character',
            '../chat'
        )

        expect(workspace.directory.startsWith(directory)).toBe(true)
        expect(workspace.sourceSnapshotFile.startsWith(directory)).toBe(true)
        expect(workspace.directory).not.toContain('..')
        expect(workspace.directory).toBe(resolveMemoryWorkspace(
            directory,
            '../../character',
            '../chat'
        ).directory)
    })

    it('rejects a symbolic link in the workspace path', async () => {
        const directory = await temporaryDirectory()
        const outside = await temporaryDirectory()
        await fs.symlink(outside, join(directory, 'risubard'), 'junction')
        const adapter = createSourceSnapshotAdapter(directory)

        await expect(adapter.saveSnapshot(
            'char',
            'chat',
            createNarrativeSourceSnapshot([{
                sourceId: 'source',
                kind: 'lorebook-entry',
                content: 'Lore',
            }])
        )).rejects.toThrow(/symbolic link/)
    })
})
