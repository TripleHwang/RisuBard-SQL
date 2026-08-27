import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const { createSqlCharacterRepair, REPAIR_UNAVAILABLE_REASON, unavailableReasonFor, normalizeCandidateSource } = require('./sql-character-repair.cjs')
const { statementsForLegacy } = require('./sql-legacy-migration.cjs')
const {
  readBoundedRisuSave,
  MAX_REPAIR_DECOMPRESSED_BYTES,
  MAX_REPAIR_BACKUP_BYTES,
  MAX_REPAIR_NODE_COUNT,
  MAX_REPAIR_ARRAY_LENGTH,
  MAX_REPAIR_STRING_BYTES,
} = require('./sql-repair-decode.cjs')
const { encodeRisuSaveLegacy } = require('./utils.cjs')
const { pack } = require('msgpackr')
const { compressSync, deflateSync } = require('fflate')

const compressedBomb = Buffer.concat([
  Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]),
  Buffer.from(compressSync(pack({ characters: [{ chaId: 'char-1', description: 'backup', chats: [] }], botPresets: [], payload: 'x'.repeat((MAX_REPAIR_DECOMPRESSED_BYTES ?? 0) + 1) }))),
])
const headerlessDeflateBomb = Buffer.from(deflateSync(pack({ characters: [{ chaId: 'char-1', description: 'backup', chats: [] }], botPresets: [], payload: 'x'.repeat(MAX_REPAIR_DECOMPRESSED_BYTES + 1) })))

// A save built with the repo's own encoder, sized past the OLD 8MB
// decompressed cap. Uncompressed on purpose: that is exactly how
// `database/database.bin` and `database/pre-sql-migration-v1.bin` are written,
// and it is the shape the old cap rejected out of hand.
function realisticSave(characterId: string, approxBytes: number, extraCharacters: unknown[] = []) {
  const filler = 'The rain kept falling against the window and nothing moved. '
  const body = filler.repeat(Math.ceil(approxBytes / filler.length))
  return Buffer.from(encodeRisuSaveLegacy({
    characters: [
      ...extraCharacters,
      { chaId: characterId, name: 'Recovered', description: 'restored body', personality: 'Kind', desc: body, chats: [] },
    ],
    botPresets: [],
  }))
}

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
    // The one candidate that existed could not be read. Nothing was searched,
    // so the reason may not speak to whether the character is in a backup.
    ['a missing backup', { characters: [{ chaId: 'char-1', chats: [] }] }, null, 'unavailable', 'all-unreadable'],
    // An unmatched backup ID means the ONLY candidate offered was read and
    // exhausted without a usable match. Coverage was complete (1 of 1
    // examined), so absence IS established: 'absent-from-all'. The current row
    // is still collapsed, so this must be 'unavailable', never 'not-needed' —
    // 'not-needed' is reserved for an already-healthy row.
    ['an unmatched backup ID', { characters: [{ chaId: 'char-1', chats: [] }] }, { characters: [{ chaId: 'other', description: 'backup', chats: [] }] }, 'unavailable', 'absent-from-all'],
    // A backup entry that matches by ID but has no meaningful body (same
    // guard as "genuinely blank current character, genuinely blank backup")
    // must also exhaust to 'unavailable', not silently do nothing as
    // 'not-needed' — the current row IS collapsed here, unlike the
    // "not-needed" cases above where the CURRENT row already has a body.
    ['a matching backup ID with no meaningful body (genuinely blank everywhere)', { characters: [{ chaId: 'char-1', chats: [] }] }, { characters: [{ chaId: 'char-1', description: '   ', chats: [] }] }, 'unavailable', 'absent-from-all'],
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

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      status: 'unavailable',
      revision: 1,
      reason: 'all-unreadable',
      backups: { total: 1, examined: 0, unreadable: 1, skipped: 0 },
    })
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

  it('reports unavailable/absent-from-all when every candidate decodes but none contain the target', async () => {
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

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      status: 'unavailable',
      revision: 1,
      reason: 'absent-from-all',
      backups: { total: 2, examined: 2, unreadable: 0, skipped: 0 },
    })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('reports unavailable/all-unreadable when every candidate fails to decode', async () => {
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

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      status: 'unavailable',
      revision: 1,
      reason: 'all-unreadable',
      backups: { total: 2, examined: 0, unreadable: 2, skipped: 0 },
    })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('reports unavailable/no-backups and never calls readBackupCandidates a second time when the list is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackupCandidates: async () => [] })

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      status: 'unavailable',
      revision: 1,
      reason: 'no-backups',
      backups: { total: 0, examined: 0, unreadable: 0, skipped: 0 },
    })
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
    expect(result).toMatchObject({ status: 'unavailable', reason: 'absent-from-all', revision: 1 })
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

function collapsedStorage() {
  const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
  const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
  storage.commitLegacyMigration(0, statementsForLegacy({ characters: [{ chaId: 'char-1', chats: [] }] }))
  return storage
}

describe('repair unavailable reason contract', () => {
  // The reason code is the ONLY thing standing between the user and a message
  // that overstates the search, so pin the whole truth table.
  it.each([
    // total, examined, unreadable -> reason
    [0, 0, 0, REPAIR_UNAVAILABLE_REASON.NO_BACKUPS],
    [1, 0, 1, REPAIR_UNAVAILABLE_REASON.ALL_UNREADABLE],
    [5, 0, 5, REPAIR_UNAVAILABLE_REASON.ALL_UNREADABLE],
    // Backups exist but none were even attempted: still "we did not look".
    [5, 0, 0, REPAIR_UNAVAILABLE_REASON.ALL_UNREADABLE],
    [1, 1, 0, REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_ALL],
    [4, 4, 0, REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_ALL],
    // Partial coverage — some read, some not — can never claim absence.
    [4, 3, 1, REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_EXAMINED],
    [12, 3, 0, REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_EXAMINED],
    [12, 1, 2, REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_EXAMINED],
  ])('total=%i examined=%i unreadable=%i -> %s', (total, examined, unreadable, expected) => {
    expect(unavailableReasonFor({ total, examined, unreadable })).toBe(expected)
  })

  it('only absent-from-all is reachable with complete coverage', () => {
    // Any incomplete sweep must fall to a reason that does not assert absence.
    for (let total = 1; total <= 6; total++) {
      for (let examined = 0; examined <= total; examined++) {
        const reason = unavailableReasonFor({ total, examined, unreadable: total - examined })
        if (reason === REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_ALL) expect(examined).toBe(total)
        else expect(examined).toBeLessThan(total)
      }
    }
  })

  it('accepts both the legacy array shape and the { candidates, total } shape', () => {
    const thunk = async () => null
    expect(normalizeCandidateSource([thunk, thunk])).toMatchObject({ total: 2 })
    expect(normalizeCandidateSource({ candidates: [thunk], total: 9 })).toMatchObject({ total: 9 })
    // total can never be reported as less than what was actually offered
    expect(normalizeCandidateSource({ candidates: [thunk, thunk, thunk], total: 1 })).toMatchObject({ total: 3 })
    expect(normalizeCandidateSource(null)).toMatchObject({ total: 0 })
    expect(normalizeCandidateSource({ candidates: [thunk] })).toMatchObject({ total: 1 })
  })
})

describe('repair backup census reaches the caller', () => {
  it('reports skipped backups the caller never offered, and refuses to claim absence', async () => {
    const storage = collapsedStorage()
    const before = JSON.stringify(storage.dump().tables)
    // 12 backups exist; the caller's budget only offered the newest 3, and all
    // 3 were read without finding the character. The old code called this
    // "no-candidate" and told the user it was in NO backup — while 9 backups
    // sat unopened.
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({
        total: 12,
        candidates: [
          async () => ({ characters: [{ chaId: 'other-a', description: 'x', chats: [] }] }),
          async () => ({ characters: [{ chaId: 'other-b', description: 'x', chats: [] }] }),
          async () => ({ characters: [{ chaId: 'other-c', description: 'x', chats: [] }] }),
        ],
      }),
    })

    const result = await repair.repair('char-1')
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'absent-from-examined',
      backups: { total: 12, examined: 3, unreadable: 0, skipped: 9 },
    })
    expect(result.reason).not.toBe('absent-from-all')
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })

  it('separates unreadable from skipped in the census', async () => {
    const storage = collapsedStorage()
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({
        total: 7,
        candidates: [
          async () => ({ characters: [{ chaId: 'other', description: 'x', chats: [] }] }), // examined
          async () => null,                                                                // unreadable
          async () => { throw new Error('corrupt') },                                      // unreadable
        ],
      }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      reason: 'absent-from-examined',
      backups: { total: 7, examined: 1, unreadable: 2, skipped: 4 },
    })
  })

  it('always satisfies total === examined + unreadable + skipped', async () => {
    for (const [total, offered] of [[1, 1], [3, 3], [10, 4], [6, 2]] as const) {
      const storage = collapsedStorage()
      const repair = createSqlCharacterRepair({
        relationalSql: storage,
        readBackupCandidates: async () => ({
          total,
          candidates: Array.from({ length: offered }, (_, i) => async () =>
            (i % 2 === 0 ? { characters: [{ chaId: 'nope', description: 'x', chats: [] }] } : null)),
        }),
      })
      const { backups } = await repair.repair('char-1')
      expect(backups.examined + backups.unreadable + backups.skipped).toBe(backups.total)
      expect(backups.total).toBe(total)
    }
  })

  it('counts a decoded-but-shapeless backup as examined, not unreadable', async () => {
    // It WAS read, and reading it did establish the character is not in it.
    const storage = collapsedStorage()
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({ total: 1, candidates: [async () => ({ notCharacters: true })] }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      reason: 'absent-from-all',
      backups: { total: 1, examined: 1, unreadable: 0, skipped: 0 },
    })
  })

  it('stops opening new candidates once the decode time budget is spent and reports the rest as skipped', async () => {
    const storage = collapsedStorage()
    let clock = 0
    const opened: number[] = []
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      decodeBudgetMs: 100,
      now: () => clock,
      readBackupCandidates: async () => ({
        total: 5,
        candidates: Array.from({ length: 5 }, (_, i) => async () => {
          opened.push(i)
          clock += 60 // each decode burns 60ms of the 100ms budget
          return { characters: [{ chaId: 'other', description: 'x', chats: [] }] }
        }),
      }),
    })

    const result = await repair.repair('char-1')
    // Candidate 0 runs at t=0, candidate 1 at t=60; at t=120 the budget is out.
    expect(opened).toEqual([0, 1])
    expect(result).toMatchObject({
      reason: 'absent-from-examined',
      backups: { total: 5, examined: 2, unreadable: 0, skipped: 3 },
    })
  })

  it('does not let the time budget abort a repair that would have succeeded on an already-open candidate', async () => {
    const storage = collapsedStorage()
    let clock = 0
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      decodeBudgetMs: 1,
      now: () => clock,
      readBackupCandidates: async () => ({
        total: 3,
        candidates: [
          async () => { clock += 5000; return { characters: [{ chaId: 'char-1', description: 'recovered late', chats: [] }] } },
          async () => ({ characters: [{ chaId: 'char-1', description: 'never reached', chats: [] }] }),
        ],
      }),
    })

    // The budget is checked BEFORE opening a candidate, so the first one always
    // gets its chance — a recovery already in hand is never thrown away.
    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired' })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'recovered late' })
  })
})

// FACT 2 reproductions: the exact three scenarios the old two-code contract
// mislabelled. Each asserts the OLD wrong answer can no longer come back.
describe('regression: reason codes must not overstate what was checked', () => {
  it('small backup decodes with no match while larger ones are rejected by the byte cap -> absent-from-examined (was: no-candidate)', async () => {
    const storage = collapsedStorage()
    const small = realisticSave('someone-else', 64 * 1024)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({
        total: 3,
        candidates: [
          () => readBoundedRisuSave(small),                // decodes, no match
          () => readBoundedRisuSave(compressedBomb),       // rejected by the cap
          () => readBoundedRisuSave(headerlessDeflateBomb),// rejected by the cap
        ],
      }),
    })

    const result = await repair.repair('char-1')
    expect(result.reason).toBe('absent-from-examined')
    // The old contract answered 'no-candidate', whose message claimed the
    // character was in no backup at all.
    expect(result.reason).not.toBe('absent-from-all')
    expect(result.backups).toMatchObject({ total: 3, examined: 1, unreadable: 2, skipped: 0 })
  })

  it('every candidate rejected by the byte cap -> all-unreadable with nothing examined (was: decode-failed, same code as a corrupt blob)', async () => {
    const storage = collapsedStorage()
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({
        total: 2,
        candidates: [
          () => readBoundedRisuSave(compressedBomb),
          () => readBoundedRisuSave(headerlessDeflateBomb),
        ],
      }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      reason: 'all-unreadable',
      backups: { total: 2, examined: 0, unreadable: 2, skipped: 0 },
    })
  })

  it('no backups on disk at all -> no-backups, distinct from every examined case (was: no-candidate)', async () => {
    const storage = collapsedStorage()
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({ total: 0, candidates: [] }),
    })

    const result = await repair.repair('char-1')
    expect(result.reason).toBe('no-backups')
    // Must not share a code with "we looked and it wasn't there".
    expect(result.reason).not.toBe('absent-from-all')
    expect(result.reason).not.toBe('absent-from-examined')
    expect(result.backups).toMatchObject({ total: 0, examined: 0, unreadable: 0, skipped: 0 })
  })
})

// FACT 1 reproduction: the decode budget must cover a realistic database.
describe('regression: the repair decode budget covers realistic saves', () => {
  it('exposes a budget sized for real databases, not an 8MB toy', () => {
    expect(MAX_REPAIR_DECOMPRESSED_BYTES).toBeGreaterThanOrEqual(128 * 1024 * 1024)
    // The two highest-priority candidates are written uncompressed, so the raw
    // cap must not sit below the decompressed cap or it silently overrides it.
    expect(MAX_REPAIR_BACKUP_BYTES).toBeGreaterThanOrEqual(MAX_REPAIR_DECOMPRESSED_BYTES)
    // Short-message chat logs run ~57.5k nodes per decompressed MB, so the
    // node cap has to keep pace with the byte cap or it binds first — which is
    // exactly what happened at 250k nodes (~4.3MB).
    expect(MAX_REPAIR_NODE_COUNT).toBeGreaterThanOrEqual(57_500 * (MAX_REPAIR_DECOMPRESSED_BYTES / 1048576))
    expect(MAX_REPAIR_STRING_BYTES).toBeGreaterThanOrEqual(MAX_REPAIR_DECOMPRESSED_BYTES)
    expect(MAX_REPAIR_ARRAY_LENGTH).toBeGreaterThanOrEqual(1_000_000)
  })

  it.each([
    ['~1MB', 1024 * 1024],
    ['~10MB (rejected outright by the old 8MB cap)', 10 * 1024 * 1024],
    ['~20MB (rejected outright by the old 8MB cap)', 20 * 1024 * 1024],
  ])('decodes a %s uncompressed save built with the repo encoder', async (_label, size) => {
    const save = realisticSave('char-1', size)
    expect(save.byteLength).toBeGreaterThan(size)
    const decoded = await readBoundedRisuSave(save)
    expect(decoded?.characters?.[0]?.chaId).toBe('char-1')
  })

  it('repairs a collapsed character from a ~20MB uncompressed backup end to end', async () => {
    const storage = collapsedStorage()
    const save = realisticSave('char-1', 20 * 1024 * 1024)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({ total: 1, candidates: [() => readBoundedRisuSave(save)] }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired', revision: 2 })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'restored body', personality: 'Kind' })
  })

  it('still rejects a save past the raised cap, cheaply and without touching the row', async () => {
    const storage = collapsedStorage()
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({
      relationalSql: storage,
      readBackupCandidates: async () => ({ total: 1, candidates: [() => readBoundedRisuSave(compressedBomb)] }),
    })

    await expect(repair.repair('char-1')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'all-unreadable',
      backups: { total: 1, examined: 0, unreadable: 1, skipped: 0 },
    })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })
})
