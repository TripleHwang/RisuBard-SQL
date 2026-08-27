import { afterEach, describe, expect, it } from 'vitest'
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

describe('SQL character body repair', () => {
  it('repairs only a collapsed matching character extension and leaves live chats and messages untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    const current = { characters: [{ chaId: 'char-1', name: 'Summary', chats: [{ id: 'chat-1', name: 'Live', message: [{ chatId: 'm-1', data: 'live message' }] }] }] }
    storage.commitLegacyMigration(0, statementsForLegacy(current))
    const before = storage.dump().tables
    const chatHash = JSON.stringify({ chats: before.chats, messages: before.messages, chatNodes: before.chat_extension_nodes, messageNodes: before.message_extension_nodes })
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackup: async () => ({ characters: [{ chaId: 'char-1', description: 'Recovered body', personality: 'Kind', tags: ['restored'], chats: [{ id: 'old', message: [] }] }] }) })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'repaired', revision: 2 })
    expect(storage.loadCharacter('char-1')?.character).toMatchObject({ description: 'Recovered body', personality: 'Kind', tags: ['restored'], chats: [{ id: 'chat-1' }] })
    const after = storage.dump().tables
    expect(JSON.stringify({ chats: after.chats, messages: after.messages, chatNodes: after.chat_extension_nodes, messageNodes: after.message_extension_nodes })).toBe(chatHash)
  })

  it.each([
    ['a legitimate minimal current character', { characters: [{ chaId: 'char-1', description: '', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with a canonical desc body', { characters: [{ chaId: 'char-1', desc: 'authored description', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with canonical notes', { characters: [{ chaId: 'char-1', notes: 'authored notes', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with canonical emotion images', { characters: [{ chaId: 'char-1', emotionImages: [['happy', 'asset-ref']], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with canonical additional assets', { characters: [{ chaId: 'char-1', additionalAssets: [['sheet', 'asset-ref', 'sheet.png']], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with an authored ccAssets extension', { characters: [{ chaId: 'char-1', ccAssets: [{ name: 'portrait', uri: 'asset-ref' }], chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a current character with only persisted timestamp aliases', { characters: [{ chaId: 'char-1', creation_date: 1, modification_date: 2, chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'repaired'],
    ['a missing backup', { characters: [{ chaId: 'char-1', chats: [] }] }, null, 'unavailable'],
    ['an unmatched backup ID', { characters: [{ chaId: 'char-1', chats: [] }] }, { characters: [{ chaId: 'other', description: 'backup', chats: [] }] }, 'not-needed'],
    ['a backup that is not richer', { characters: [{ chaId: 'char-1', description: 'current', chats: [] }] }, { characters: [{ chaId: 'char-1', description: 'backup', chats: [] }] }, 'not-needed'],
  ])('handles %s without touching unrelated records', async (_name, current, backup, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'risu-character-repair-')); roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }); storages.push(storage)
    storage.commitLegacyMigration(0, statementsForLegacy(current))
    const before = JSON.stringify(storage.dump().tables)
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackup: async () => backup })
    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: expected, revision: expected === 'repaired' ? 2 : 1 })
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
    const repair = createSqlCharacterRepair({ relationalSql: storage, readBackup: async () => Buffer.isBuffer(backup) ? readBoundedRisuSave(backup) : backup })

    await expect(repair.repair('char-1')).resolves.toMatchObject({ status: 'unavailable', revision: 1 })
    expect(JSON.stringify(storage.dump().tables)).toBe(before)
  })
})
