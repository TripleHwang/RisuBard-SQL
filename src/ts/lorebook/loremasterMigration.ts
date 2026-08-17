import type { loreBook } from '../storage/database.svelte'

type LegacyEntry = loreBook & { disabled?: boolean }

export type LoremasterMigrationResult = {
    entries: loreBook[]
    changed: boolean
    restoredIds: string[]
}

const lorebookModes = new Set<loreBook['mode']>([
    'multiple',
    'constant',
    'normal',
    'child',
    'folder',
])

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidBackup(value: unknown, expectedId: string): value is LegacyEntry {
    if (!isRecord(value)) return false
    if (value.id !== undefined && value.id !== expectedId) return false

    return typeof value.key === 'string'
        && typeof value.secondkey === 'string'
        && typeof value.insertorder === 'number'
        && Number.isFinite(value.insertorder)
        && typeof value.comment === 'string'
        && typeof value.content === 'string'
        && typeof value.mode === 'string'
        && lorebookModes.has(value.mode as loreBook['mode'])
        && typeof value.alwaysActive === 'boolean'
        && typeof value.selective === 'boolean'
}

export function migrateLoremasterDisabledEntries(
    entries: LegacyEntry[],
    backups: Record<string, LegacyEntry>,
): LoremasterMigrationResult {
    if (!isRecord(backups)) {
        return { entries, changed: false, restoredIds: [] }
    }

    const idCounts = new Map<string, number>()
    for (const entry of entries) {
        if (typeof entry.id === 'string' && entry.id) {
            idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1)
        }
    }

    const restoredIds: string[] = []
    const next = entries.map((entry) => {
        const id = entry.id
        if (
            entry.disabled !== true
            || typeof id !== 'string'
            || !id
            || idCounts.get(id) !== 1
            || !Object.prototype.hasOwnProperty.call(backups, id)
        ) {
            return entry
        }

        const backupEntry = backups[id]
        if (!isValidBackup(backupEntry, id)) return entry

        const { disabled: ignoredBackupDisabled, ...original } = backupEntry
        restoredIds.push(id)
        return {
            ...original,
            id,
            folder: entry.folder,
            insertorder: entry.insertorder,
            enabled: false,
        }
    })

    return restoredIds.length === 0
        ? { entries, changed: false, restoredIds }
        : { entries: next, changed: true, restoredIds }
}
