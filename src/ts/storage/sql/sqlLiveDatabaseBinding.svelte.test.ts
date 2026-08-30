/**
 * The persistence runtime must commit what the user actually changed.
 *
 * Every existing runtime test handed `activateSqlPersistenceRuntime` the very
 * same object it then mutated, so the raw/proxy distinction never appeared.
 * Boot does not do that. `openExistingStandaloneSql` activates the runtime with
 * the object storage returned, and only afterwards does `setDatabase` wrap that
 * object as `DBState.db` -- a Svelte 5 `$state` proxy, which never writes
 * through to its target. Every user mutation goes through the proxy; the
 * runtime held the target.
 *
 * These tests reproduce that ordering exactly and assert on the commit the
 * runtime builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage, SqlLoadDatabaseResult } from './ISqlStorage'
import type { SqlCommit } from './sqlCommit'
import type { Database } from '../database.svelte'
import { getDatabase, setDatabase } from '../database.svelte'
import { DBState } from '../../stores.svelte'
import { openExistingStandaloneSql, setActiveSqlStorageForTesting } from './sqlBootstrap'
import {
    activateSqlPersistenceRuntime,
    flushSqlDirtyChanges,
    markSqlCharacterDirty,
    markSqlMessageDirty,
    markSqlRootDirty,
    resetSqlPersistenceRuntimeForTesting,
} from './sqlPersistenceRuntime'

const CHARACTER_ID = 'character-live-binding'
const CHAT_ID = 'chat-live-binding'

const commits: SqlCommit[] = []

function fakeStorage(loads: SqlLoadDatabaseResult[]): ISqlStorage {
    return {
        backendKind: 'native-sqlite' as const,
        init: vi.fn(async () => true),
        loadDatabase: vi.fn(async () => loads.shift() ?? null),
        replaceDatabase: vi.fn(async () => true),
        getRevision: vi.fn(() => 7),
        commit: vi.fn(async (commit: SqlCommit) => {
            commits.push(commit)
            return { revision: 8 }
        }),
    } as unknown as ISqlStorage
}

/**
 * The shape storage returns at boot: a plain object, no proxy anywhere. The
 * chat is fully resident so canonical positions are plain array indexes and the
 * assertions stay about the raw/proxy split and nothing else.
 */
function storedDatabase(): Database {
    return {
        username: 'name at boot',
        characters: [{
            chaId: CHARACTER_ID,
            type: 'character',
            name: 'Ada',
            desc: 'description at boot',
            chatPage: 0,
            chats: [{
                id: CHAT_ID,
                name: 'Chat 0',
                note: '',
                localLore: [],
                message: [{ role: 'char', data: 'greeting', chatId: `${CHAT_ID}-msg-0` }],
            }],
        }],
        botPresets: [],
    } as unknown as Database
}

let previousDatabase: Database

/** Boot, in the order `loadData` performs it. */
async function boot(): Promise<Database> {
    const stored = storedDatabase()
    const storage = fakeStorage([{ status: 'ready', revision: 7, database: stored }])
    // sqlBootstrap.ts:144 -- activates the persistence runtime with `stored`.
    const opened = await openExistingStandaloneSql(storage)
    expect(opened?.usingSql).toBe(true)
    // bootstrap.ts:154 -- only now is that same object wrapped as `DBState.db`.
    setDatabase(opened!.database)
    // The premise of every test below: `DBState.db` is a real `$state` proxy of
    // `stored`, not `stored`. Asserted rather than assumed -- under a transform
    // where `$state` yields no proxy (a node-environment test file, for
    // instance) the two are the same object and none of these tests can fail.
    expect(getDatabase()).not.toBe(stored)
    return stored
}

beforeEach(() => {
    commits.length = 0
    previousDatabase = DBState.db
    resetSqlPersistenceRuntimeForTesting()
})

afterEach(() => {
    resetSqlPersistenceRuntimeForTesting()
    setActiveSqlStorageForTesting(null)
    DBState.db = previousDatabase
})

describe('the SQL persistence runtime after a normal boot', () => {
    it('commits a root setting the user changed through the live database', async () => {
        await boot()

        getDatabase().username = 'name the user typed'
        markSqlRootDirty('username')
        await flushSqlDirtyChanges()

        const upserts = commits.flatMap(commit => commit.root.upserts)
        expect(upserts).toContainEqual({ key: 'username', value: 'name the user typed' })
    })

    it('commits a message appended through the live database', async () => {
        await boot()

        const chat = getDatabase().characters[0].chats[0]
        const appendedId = `${CHAT_ID}-msg-appended`
        chat.message.push({ role: 'user', data: 'the message the user sent', chatId: appendedId } as never)
        markSqlMessageDirty(CHAT_ID, appendedId)
        await flushSqlDirtyChanges()

        const messages = commits.flatMap(commit => commit.messages)
        expect(messages.map(message => message.id)).toContain(appendedId)
        expect(messages.find(message => message.id === appendedId)?.data)
            .toMatchObject({ data: 'the message the user sent' })
    })

    it('commits a character edit made through the live database', async () => {
        await boot()

        getDatabase().characters[0].desc = 'description the user wrote'
        markSqlCharacterDirty(CHARACTER_ID)
        await flushSqlDirtyChanges()

        const characters = commits.flatMap(commit => commit.characters)
        expect(characters.find(entry => entry.id === CHARACTER_ID)?.data)
            .toMatchObject({ desc: 'description the user wrote' })
    })

    /**
     * The window between `activateSqlStorage` and `setDatabase`.
     *
     * `DBState.db` is `{}` until `setDatabase` installs the real graph, and a
     * commit built from `{}` is not a no-op: every dirty root key reads as
     * `undefined` and becomes a DELETE, and every dirty character fails its
     * lookup and becomes a characterDelete. A flush that lands in that window
     * must therefore write nothing AND acknowledge nothing, so the marks are
     * still there when the graph arrives.
     */
    it('writes nothing and keeps its marks while no live database is installed', async () => {
        const storage = fakeStorage([])
        activateSqlPersistenceRuntime(storage, () => null)

        markSqlRootDirty('username')
        markSqlCharacterDirty(CHARACTER_ID)
        await flushSqlDirtyChanges()
        expect(commits).toHaveLength(0)

        // The graph arrives. The marks made in the window are still pending.
        await boot()
        getDatabase().username = 'name the user typed'
        await flushSqlDirtyChanges()

        const upserts = commits.flatMap(commit => commit.root.upserts)
        expect(upserts).toContainEqual({ key: 'username', value: 'name the user typed' })
        expect(commits.flatMap(commit => commit.root.deletes)).not.toContain('username')
        expect(commits.flatMap(commit => commit.characterDeletes ?? [])).toHaveLength(0)
    })

    /**
     * The console line the user reported. Hydration sets `detailsLoaded = true`
     * through the proxy; a runtime reading the raw object sees `false` forever
     * and refuses to write a character the user has opened.
     */
    it('does not mistake a hydrated character for an unloaded bootstrap summary', async () => {
        await boot()

        const stored = getDatabase().characters[0] as { detailsLoaded?: boolean }
        stored.detailsLoaded = false
        markSqlCharacterDirty(CHARACTER_ID)
        await flushSqlDirtyChanges()
        expect(commits.flatMap(commit => commit.characters)).toHaveLength(0)

        // The user opens the character; hydration marks it loaded.
        stored.detailsLoaded = true
        markSqlCharacterDirty(CHARACTER_ID)
        await flushSqlDirtyChanges()

        expect(commits.flatMap(commit => commit.characters).map(entry => entry.id))
            .toContain(CHARACTER_ID)
    })
})
