import { describe, test, expect, vi, beforeEach } from 'vitest'

// In-memory forage stub. `setItemDelay` lets a save be made slower than a
// following remove (so the ordering test fails loudly if writes ever run
// concurrently again); `setItemThrowsAfterStore` simulates a write the server
// commits but whose response is lost.
const { mockStore, mockState } = vi.hoisted(() => ({
    mockStore: new Map<string, Uint8Array>(),
    mockState: { setItemDelay: 0, setItemThrowsAfterStore: false },
}))
const { activeSql, sqlDrafts } = vi.hoisted(() => ({
    activeSql: { current: null as any },
    sqlDrafts: new Map<string, { m: string, t: string }>(),
}))

vi.mock('./sql/sqlBootstrap', () => ({
    getActiveSqlStorage: () => activeSql.current,
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        async keys(prefix = '') {
            return [...mockStore.keys()].filter((k) => k.startsWith(prefix))
        },
        async setItem(key: string, value: Uint8Array) {
            if (mockState.setItemDelay) await new Promise((r) => setTimeout(r, mockState.setItemDelay))
            mockStore.set(key, value) // server commits
            if (mockState.setItemThrowsAfterStore) throw new Error('response lost') // ...but the response is dropped
        },
        async getItem(key: string) {
            return mockStore.get(key) ?? null
        },
        async removeItem(key: string) {
            mockStore.delete(key)
        },
    },
}))

const {
    loadChatDraft,
    flushChatDraft,
    removeChatDraft,
    sweepOrphanDrafts,
    chatDraftKey,
} = await import('./chatDraft')

beforeEach(() => {
    mockStore.clear()
    sqlDrafts.clear()
    activeSql.current = null
    mockState.setItemDelay = 0
    mockState.setItemThrowsAfterStore = false
})

function enableSqlDrafts() {
    activeSql.current = {
        async listChatDraftKeys() { return [...sqlDrafts.keys()] },
        async getChatDraft(key: string) { return sqlDrafts.get(key) ?? null },
        async setChatDraft(key: string, draft: { m: string, t: string }) { sqlDrafts.set(key, draft) },
        async removeChatDrafts(keys: string[]) {
            for (const key of keys) sqlDrafts.delete(key)
            return keys.length
        },
    }
}

// Each test uses a distinct character id so the module-level index cannot leak
// between cases.

describe('chatDraft write ordering', () => {
    test('a delayed save cannot resurrect a draft a later remove deleted', async () => {
        mockState.setItemDelay = 50 // make the save land well after the remove would
        flushChatDraft('ser', 'c1', { m: 'hello', t: '' })
        removeChatDraft('ser', 'c1') // sent: must still win the race
        const loaded = await loadChatDraft('ser', 'c1') // drains the queue, then reads
        expect(loaded).toBeNull()
        expect(mockStore.has(chatDraftKey('ser', 'c1'))).toBe(false)
    })

    test('a sent chat can still hold a new draft afterwards', async () => {
        flushChatDraft('ser2', 'c1', { m: 'first', t: '' })
        removeChatDraft('ser2', 'c1') // message sent
        flushChatDraft('ser2', 'c1', { m: 'second', t: '' }) // user types again
        const loaded = await loadChatDraft('ser2', 'c1')
        expect(loaded).toEqual({ m: 'second', t: '' })
    })

    test('send removes a draft whose save response was lost (server has it, index does not)', async () => {
        mockState.setItemThrowsAfterStore = true
        flushChatDraft('lost', 'c1', { m: 'sent text', t: '' }) // server stores it, response dropped
        await new Promise((r) => setTimeout(r, 0)) // let the failed save settle (not indexed)
        mockState.setItemThrowsAfterStore = false
        expect(mockStore.has(chatDraftKey('lost', 'c1'))).toBe(true) // stale draft sits on the server
        removeChatDraft('lost', 'c1') // sent: must remove despite the missing index entry
        await loadChatDraft('lost', 'c1') // drain
        expect(mockStore.has(chatDraftKey('lost', 'c1'))).toBe(false)
    })
})

describe('sweepOrphanDrafts', () => {
    test('removes drafts whose chat is gone, keeps existing ones', async () => {
        flushChatDraft('keep', 'c1', { m: 'still here', t: '' })
        flushChatDraft('gone', 'c1', { m: 'orphan', t: '' })
        await loadChatDraft('keep', 'c1') // drain the saves
        await sweepOrphanDrafts(new Set([chatDraftKey('keep', 'c1')]))
        await loadChatDraft('keep', 'c1') // drain the sweep removes
        expect(mockStore.has(chatDraftKey('keep', 'c1'))).toBe(true)
        expect(mockStore.has(chatDraftKey('gone', 'c1'))).toBe(false)
    })
})

describe('chatDraft round trip', () => {
    test('load returns a saved draft including the translate buffer', async () => {
        flushChatDraft('load', 'c1', { m: 'remember me', t: 'tr' })
        const loaded = await loadChatDraft('load', 'c1')
        expect(loaded).toEqual({ m: 'remember me', t: 'tr' })
    })

    test('load returns null for a chat with no draft', async () => {
        const loaded = await loadChatDraft('empty', 'c1')
        expect(loaded).toBeNull()
    })
})

describe('standalone SQL drafts', () => {
    test('writes, reads, and removes drafts without creating KV sidecars', async () => {
        enableSqlDrafts()
        flushChatDraft('sql', 'c1', { m: 'canonical', t: '번역' })
        expect(await loadChatDraft('sql', 'c1')).toEqual({ m: 'canonical', t: '번역' })
        expect(sqlDrafts.get(chatDraftKey('sql', 'c1'))).toEqual({ m: 'canonical', t: '번역' })
        expect(mockStore.has(chatDraftKey('sql', 'c1'))).toBe(false)

        removeChatDraft('sql', 'c1')
        expect(await loadChatDraft('sql', 'c1')).toBeNull()
        expect(sqlDrafts.has(chatDraftKey('sql', 'c1'))).toBe(false)
    })

    test('migrates an existing KV draft into SQL before loading it', async () => {
        const key = chatDraftKey('legacy-sql', 'c1')
        mockStore.set(key, new TextEncoder().encode(JSON.stringify({ m: 'old', t: 'buffer' })))
        enableSqlDrafts()

        expect(await loadChatDraft('legacy-sql', 'c1')).toEqual({ m: 'old', t: 'buffer' })
        expect(sqlDrafts.get(key)).toEqual({ m: 'old', t: 'buffer' })
        expect(mockStore.has(key)).toBe(false)
    })
})
