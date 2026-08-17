import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { completeMemoryWorkspaceFork } from './risubard-memory-fork'
import {
    createMemorySaveSlot,
    listMemorySaveSlots,
    prepareMemorySaveLoad,
} from './risubard-memory-save'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const roots: string[] = []

async function createRoot() {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-save-slot-'))
    roots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true })
    ))
})

describe('memory save slots', () => {
    test('stores chat bytes and a complete immutable wiki snapshot', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'chat-source')
        const scene = join(source.directory, 'wiki', 'current-scene.md')
        await fs.mkdir(dirname(scene), { recursive: true })
        await fs.writeFile(scene, '# 현재 장면\n\n성문 앞이다.', 'utf8')

        const saved = await createMemorySaveSlot({
            userDataDirectory: root,
            characterId: 'character',
            sourceChatId: 'chat-source',
            saveId: 'save-1',
            sourceChatName: '성문 앞',
            turnCount: 12,
            chatBytes: Buffer.from([1, 2, 3, 4]),
            createdAt: '2026-08-14T08:00:00.000Z',
            latestEvent: {
                title: '성문이 열렸다',
                excerpt: '경비병이 일행을 성 안으로 들였다.',
            },
        })

        expect(saved).toMatchObject({
            saveId: 'save-1', sourceChatId: 'chat-source',
            sourceChatName: '성문 앞', turnCount: 12,
            createdAt: '2026-08-14T08:00:00.000Z',
            latestEvent: { title: '성문이 열렸다' },
        })
        expect(await listMemorySaveSlots({
            userDataDirectory: root,
            characterId: 'character',
        })).toEqual([saved])

        const prepared = await prepareMemorySaveLoad({
            userDataDirectory: root,
            characterId: 'character',
            saveId: 'save-1',
            destinationChatId: 'chat-loaded',
        })
        expect(prepared.chatBytes).toEqual(Buffer.from([1, 2, 3, 4]))
        expect(prepared.fork.destinationChatId).toBe('chat-loaded')
        const destination = resolveMemoryWorkspace(
            root, 'character', 'chat-loaded'
        )
        await expect(fs.readFile(
            join(destination.directory, 'wiki', 'current-scene.md'),
            'utf8'
        )).resolves.toContain('성문 앞이다.')
        await expect(fs.stat(join(destination.directory, 'chat.bin')))
            .rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.stat(join(
            destination.directory, 'risubard-save.json'
        ))).rejects.toMatchObject({ code: 'ENOENT' })

        await completeMemoryWorkspaceFork({
            userDataDirectory: root,
            characterId: 'character',
            destinationChatId: 'chat-loaded',
            forkToken: prepared.fork.forkToken,
            action: 'finalize',
        })
    })

    test('lists complete slots newest first and ignores incomplete directories', async () => {
        const root = await createRoot()
        for (const [saveId, createdAt] of [
            ['older', '2026-08-14T07:00:00.000Z'],
            ['newer', '2026-08-14T09:00:00.000Z'],
        ] as const) {
            await createMemorySaveSlot({
                userDataDirectory: root,
                characterId: 'character',
                sourceChatId: 'source',
                saveId,
                sourceChatName: '모험',
                turnCount: 1,
                chatBytes: Buffer.from(saveId),
                createdAt,
            })
        }
        const incomplete = resolveMemoryWorkspace(
            root, 'character', 'save-slot:incomplete'
        )
        await fs.mkdir(incomplete.directory, { recursive: true })

        const slots = await listMemorySaveSlots({
            userDataDirectory: root,
            characterId: 'character',
        })
        expect(slots.map((slot) => slot.saveId)).toEqual(['newer', 'older'])
    })
})
