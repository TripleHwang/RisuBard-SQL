/**
 * Hydration must hand back the object that is in the database, not the one it
 * put there.
 *
 * Installing a freshly-fetched record into a `$state` array stores a PROXY of
 * it; the raw object the fetch produced is not what anything else will read or
 * write from that moment on. A caller given the raw object edits a detached
 * copy: no UI update, no dirty mark, nothing persisted, and no error.
 *
 * `jobRecovery.ts` already carries a comment naming that exact failure in the
 * field, and works around it by re-reading the slot. Two other callers --
 * `characters.ts` and `changeChatTo` in `globalApi.svelte.ts` -- pass the return
 * value straight into `loadTogglesFromChat`, which writes three fields into the
 * chat it is given. This test pins the fix at the source instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { character, Database } from '../database.svelte'
import { ensureCharacterHydrated } from './sqlRuntimeHydration'
import { setActiveSqlStorageForTesting } from './sqlBootstrap'
import type { ISqlStorage } from './ISqlStorage'

const CHARACTER_ID = 'character-live-slot'

function bootstrapStorage(record: character): ISqlStorage {
    return {
        backendKind: 'server-sql' as const,
        loadCharacterHydration: vi.fn(async () => record),
        loadChatMessageReversePage: vi.fn(),
        loadRootKeyHydration: vi.fn(),
    } as unknown as ISqlStorage
}

beforeEach(() => { setActiveSqlStorageForTesting(null) })
afterEach(() => { setActiveSqlStorageForTesting(null) })

describe('ensureCharacterHydrated', () => {
    it('returns the live database slot, not the raw record it installed', async () => {
        const fetched = {
            chaId: CHARACTER_ID,
            type: 'character',
            name: 'Ada',
            desc: 'from storage',
            chats: [],
        } as unknown as character
        setActiveSqlStorageForTesting(bootstrapStorage(fetched))

        const db = $state({
            characters: [{
                chaId: CHARACTER_ID,
                type: 'character',
                name: 'Ada',
                detailsLoaded: false,
                chats: [],
            }],
        }) as unknown as Database

        const hydrated = await ensureCharacterHydrated(db, 0)

        expect(hydrated).toBe(db.characters[0])
        expect(hydrated).not.toBe(fetched)

        // The caller edits what it was handed -- `loadTogglesFromChat` does
        // exactly this. The edit has to be in the database.
        hydrated!.desc = 'edited by the caller'
        expect(db.characters[0].desc).toBe('edited by the caller')
    })
})
