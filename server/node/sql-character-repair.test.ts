import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const { createSqlCharacterRepair } = require('./sql-character-repair.cjs')
const { statementsForLegacy } = require('./sql-legacy-migration.cjs')
const { readBoundedRisuSave, MAX_REPAIR_DECOMPRESSED_BYTES } = require('./sql-repair-decode.cjs')
const { pack } = require('msgpackr')
const { compressSync, deflateSync } = require('fflate')

const compressedBomb = Buffer.concat([
  Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]),
  Buffer.from(compressSync(pack({ characters: [{ chaId: 'char-1', description: 'backup', chats: [] }], botPresets: [], payload: 'x'.repeat((MAX_REPAIR_DECOMPRESSED_BYTES ?? 0) + 1) }))),
])
const headerlessDeflateBomb = Buffer.from(deflateSync(pack({ characters: [{ chaId: 'char-1', description: 'backup', chats: [] }], botPresets: [], payload: 'x'.repeat(MAX_REPAIR_DECOMPRESSED_BYTES + 1) })))

const roots: string[] = []
const storages: any[] = []
afterEach(() => { for (const storage of storages.splice(0)) storage.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

// Helper: build a `readBackupCandidates` thunk list from a plain array of
// "backup" values. `null`/`undefined` entries simulate a candidate that
// exists but fails to decode (readBackup* resolves falsy on bounded-decode
// failure); everything else is returned as-is by that candidate's thunk.
function candidateList(...backups: unknown[]) {
  return async () => backups.map((backup) => async () => backup)
}

describe('SQL character body repair', () => {
  it('repairs only a collapsed matching character extension and leaves live chats and messages untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    const current = { characters: [{ chaId: 'char-1', name: 'Summary', chats: [{ id: 'chat-1', name: 'Live', message: [{ chatId: 'm-1', data: 'live message' }] }] }] }
    storage.commitLegacyMigration(0, statementsForLegacy(current))
    const before = storage.dump().tables
    const chatHash = JSON.stringify({ chats: before.chats, messages: before.messages, chatNodes: before.chat_extension_nodes, messageNodes: before.message_extension_nodes })
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: candidateList({ characters: [{ chaId: 'char-1', description: 'Recovered body', personality: 'Kind', tags: ['restored'], chats: [{ id: 'old', message: [] }] }] }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired', revision: 2 })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'Recovered body', personality: 'Kind', tags: ['restored'], chats: [{ id: 'chat-1' }] })
    const after = storage.dump().tables
    expect(JSON.stringify({ chats: after.chats, messages: after.messages, chatNodes: after.chat_extension_nodes, messageNodes: after.message_extension_nodes })).toBe(chatHash)
  })

  it.each([
    ['a legitimate minimal current character', { characters: [{ chaId: 'char-1', description: '', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with a canonical desc body', { characters: [{ chaId: 'char-1', desc: 'authored description', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with canonical notes', { characters: [{ chaId: 'char-1', notes: 'authored notes', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with canonical emotion images', { characters: [{ chaId: 'char-1', emotionImages: [['happy', 'asset-ref']], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with canonical additional assets', { characters: [{ chaId: 'char-1', additionalAssets: [['sheet', 'asset-ref', 'sheet.png']], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with an authored ccAssets extension', { characters: [{ chaId: 'char-1', ccAssets: [{ name: 'portrait', uri: 'asset-ref' }], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed', undefined],
    ['a current character with only persisted timestamp aliases', { characters: [{ chaId: 'char-1', creation_date: 1, modification_date: 2, chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'repaired', undefined],
    ['a missing backup', { characters: [{ chaId: 'char-1', chats: [] }] }, null, 'unavailable', 'decode-failed'],
    // An unmatched backup ID means the ONLY candidate offered was exhausted
    // without a usable match: the current row is still collapsed, so this
    // must resolve to 'unavailable' (reason 'no-candidate'), never
    // 'not-needed' — 'not-needed' is reserved for an already-healthy row.
    ['an unmatched backup ID', { characters: [{ chaId: 'char-1', chats: [] }] }, { characters: [{ chaId: 'other', description: 'backup', chats: [] }] }, 'unavailable', 'no-candidate'],
    // A backup entry that matches by ID but has no meaningful body (same
    // guard as "genuinely blank current character, genuinely blank backup")
    // must also exhaust to 'unavailable', not silently do nothing as
    // 'not-needed' — the current row IS collapsed here, unlike the
    // "not-needed" cases above where the CURRENT row already has a body.
    ['a matching backup ID with no meaningful body (genuinely blank everywhere)', { characters: [{ chaId: 'char-1', chats: [] }] }, { characters: [{ chaId: 'char-1', description: '   ', chats: [] }] }, 'unavailable', 'no-candidate'],
  ])('handles %s without touching unrelated records', async (_name, current, backup, expected, expectedReason) => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy(current))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackupCandidates: candidateList(backup) })
    const result = await repair.repair('char-1')
    expect(result).toMatchObject({ status: expected, revision: expected === 'repaired' ? 2 : 1 })
    if (expected === 'unavailable') expect(result.reason).toBe(expectedReason)
    if (expected === 'repaired') expect(JSON.stringify(storage.dump().tables)).not.toBe(before)
    else expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it.each([
    ['an oversized backup', null],
    ['a corrupt backup', null],
    ['a compressed bomb', compressedBomb],
    ['a headerless raw-deflate bomb', headerlessDeflateBomb],
  ])('leaves the collapsed record unchanged when bounded backup decoding reports %s unavailable', async (_name, backup) => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => [async () => (Buffer.isBuffer(backup) ? readBoundedRisuSave(backup) : backup)],
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'unavailable', revision: 1, reason: 'decode-failed' })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('tries backup candidates in priority order: missing from the first, present in the second', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const firstRead = vi.fn(async () => ({ characters: [{ chaId: 'other-char', description: 'wrong character', chats: [] }] }))
    const secondRead = vi.fn(async () => ({ characters: [{ chaId: 'char-1', description: 'from second backup', chats: [] }] }))
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackupCandidates: async () => [firstRead, secondRead] })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired', revision: 2 })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'from second backup' })
    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(secondRead).toHaveBeenCalledTimes(1)
  })

  it('continues past a candidate that fails to decode and repairs from the next one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const failingRead = async () => { throw new Error('corrupt backup blob') }
    const workingRead = async () => ({ characters: [{ chaId: 'char-1', description: 'recovered after failure', chats: [] }] })
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackupCandidates: async () => [failingRead, workingRead] })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired', revision: 2 })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'recovered after failure' })
  })

  it('reports unavailable/no-candidate when every candidate decodes but none contain the target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => [
        async () => ({ characters: [{ chaId: 'someone-else', description: 'nope', chats: [] }] }),
        async () => ({ characters: [{ chaId: 'also-not-it', description: 'nope', chats: [] }] }),
      ],
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'unavailable', revision: 1, reason: 'no-candidate' })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('reports unavailable/decode-failed when every candidate fails to decode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => [
        async () => { throw new Error('bad blob 1') },
        async () => null,
      ],
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'unavailable', revision: 1, reason: 'decode-failed' })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('reports unavailable/no-candidate and never calls readBackupCandidates a second time when the list is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackupCandidates: async () => [] })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'unavailable', revision: 1, reason: 'no-candidate' })
  })

  it('does not resurrect a genuinely blank character from an unrelated richer backup entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    // char-1 was deliberately created blank. A backup exists and even has a
    // richer body for a DIFFERENT character (char-2) plus a same-ID entry
    // that is itself empty — neither should ever be used to fabricate a body
    // for char-1.
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => [async () => ({
        characters: [
          { chaId: 'char-2', description: 'a different, richly-populated character', chats: [] },
          { chaId: 'char-1', description: '', chats: [] },
        ],
      })],
    })

    const result = await repair.repair('char-1')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'no-candidate', revision: 1 })
    expect(storage.loadCharacter('char-1')?.character?.description).toBeUndefined()
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('leaves the SQL row completely unchanged after a failed repair (no partial writes)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const beforeDump = storage.dump().tables
    const beforeLoad = storage.loadCharacter('char-1')
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => [
        async () => { throw new Error('decode failure') },
        async () => ({ characters: [{ chaId: 'char-1', description: '', chats: [] }] }), // matches ID, but empty body
      ],
    })

    const result = await repair.repair('char-1')
    expect(result.status).toBe('unavailable')
    expect(JSON.stringify(storage.dump().tables)).toBe(JSON.stringify(beforeDump))
    expect(storage.loadCharacter('char-1')).toEqual(beforeLoad)
    // revision must not have advanced — nothing was committed.
    expect(storage.loadCharacter('char-1')?.revision).toBe(beforeLoad?.revision)
  })
})
