import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirtyRegistry } from './dirtyRegistry'

afterEach(() => {
    vi.useRealTimers()
})

describe('DirtyRegistry', () => {
    it('coalesces every scope into a deterministic snapshot', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())

        registry.markRoot('z')
        registry.markRoot('a')
        registry.markCharacter('character-z')
        registry.markCharacter('character-a')
        registry.markChat('character-b', 'chat-z')
        registry.markChat('character-a', 'chat-a', true)
        registry.markChat('character-a', 'chat-a')
        registry.markMessage('chat-z', 'message-z')
        registry.markMessage('chat-z', 'message-a')
        registry.markMessage('chat-z', 'message-a')
        registry.markMessageManifest('chat-z')
        registry.markMessageDeleted('chat-z', 'message-z')
        registry.markMessageDeleted('chat-z', 'message-a')
        registry.markPluginStorage('plugin-z')
        registry.markPluginStorage('plugin-a')
        registry.markPreset('preset-z')
        registry.markPreset('preset-a')

        expect(registry.takeSnapshot()).toEqual({
            rootKeys: ['a', 'z'],
            characterIds: ['character-a', 'character-z'],
            chats: [
                { characterId: 'character-a', chatId: 'chat-a', manifest: true },
                { characterId: 'character-b', chatId: 'chat-z', manifest: false },
            ],
            messages: [{ chatId: 'chat-z', messageIds: ['message-a', 'message-z'] }],
            messageManifestChatIds: ['chat-z'],
            messageDeletes: [{ chatId: 'chat-z', messageIds: ['message-a', 'message-z'] }],
            pluginStorageKeys: ['plugin-a', 'plugin-z'],
            presetIds: ['preset-a', 'preset-z'],
        })
    })

    it('does not acknowledge a scope re-marked while its snapshot is in flight', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())
        registry.markRoot('language')
        registry.markMessage('chat-a', 'message-a')
        const old = registry.takeSnapshot()

        registry.markRoot('language')
        registry.markMessage('chat-a', 'message-a')
        registry.acknowledge(old)

        expect(registry.takeSnapshot()).toMatchObject({
            rootKeys: ['language'],
            messages: [{ chatId: 'chat-a', messageIds: ['message-a'] }],
        })
    })

    it('acknowledges only values captured by a snapshot', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())
        registry.markRoot('language')
        const old = registry.takeSnapshot()
        registry.markRoot('theme')

        registry.acknowledge(old)

        expect(registry.takeSnapshot().rootKeys).toEqual(['theme'])
    })

    it('uses one scheduled flush timer', async () => {
        vi.useFakeTimers()
        const flush = vi.fn().mockResolvedValue(undefined)
        const registry = new DirtyRegistry(flush)

        registry.markRoot('language')
        registry.schedule(300)
        registry.schedule(300)
        await vi.advanceTimersByTimeAsync(300)

        expect(flush).toHaveBeenCalledTimes(1)
    })

    it('dedupes concurrent flushes and clears a pending timer before flushing', async () => {
        vi.useFakeTimers()
        let resolveFlush: (() => void) | undefined
        const flush = vi.fn(() => new Promise<void>(resolve => { resolveFlush = resolve }))
        const registry = new DirtyRegistry(flush)
        registry.schedule(300)

        const first = registry.flushNow()
        const second = registry.flushNow()
        await Promise.resolve()
        expect(flush).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(300)
        expect(flush).toHaveBeenCalledOnce()

        resolveFlush?.()
        await expect(first).resolves.toBeUndefined()
        await expect(second).resolves.toBeUndefined()
    })

    it('keeps dirty state after a rejected flush so a later scheduled retry can succeed', async () => {
        vi.useFakeTimers()
        const flush = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(undefined)
        const registry = new DirtyRegistry(flush)
        registry.markRoot('language')

        await expect(registry.flushNow()).rejects.toThrow('offline')
        expect(registry.takeSnapshot().rootKeys).toEqual(['language'])

        registry.schedule(20)
        await vi.advanceTimersByTimeAsync(20)
        expect(flush).toHaveBeenCalledTimes(2)
    })
})
