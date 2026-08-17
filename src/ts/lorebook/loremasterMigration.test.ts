import { describe, expect, it } from 'vitest'
import type { loreBook } from '../storage/database.svelte'
import { migrateLoremasterDisabledEntries } from './loremasterMigration'

type LegacyEntry = loreBook & { disabled?: boolean }

function placeholder(overrides: Partial<LegacyEntry> = {}): LegacyEntry {
    return {
        id: 'lore-1',
        comment: '[X] Library',
        key: '',
        secondkey: '',
        content: '',
        insertorder: 30,
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        folder: '\uf000folder:places',
        disabled: true,
        ...overrides,
    }
}

function backup(overrides: Partial<LegacyEntry> = {}): LegacyEntry {
    return {
        ...placeholder(),
        comment: 'Library',
        key: 'books',
        content: 'Full text',
        alwaysActive: true,
        ...overrides,
    }
}

describe('Loremaster disabled migration', () => {
    it('restores content while keeping placeholder folder and order', () => {
        const current = placeholder()
        const original = backup({
            secondkey: 'archive',
            folder: '\uf000folder:old-location',
            insertorder: 999,
            disabled: true,
            customMetadata: { source: 'legacy' },
        } as Partial<LegacyEntry>)
        const backups = { 'lore-1': original }

        const result = migrateLoremasterDisabledEntries([current], backups)

        expect(result.changed).toBe(true)
        expect(result.restoredIds).toEqual(['lore-1'])
        expect(result.entries[0]).toMatchObject({
            id: 'lore-1',
            comment: 'Library',
            key: 'books',
            secondkey: 'archive',
            content: 'Full text',
            alwaysActive: true,
            folder: '\uf000folder:places',
            insertorder: 30,
            enabled: false,
            customMetadata: { source: 'legacy' },
        })
        expect(result.entries[0]).not.toHaveProperty('disabled')
        expect(current).toHaveProperty('disabled', true)
        expect(original).toHaveProperty('disabled', true)
    })

    it('leaves unmatched entries unchanged', () => {
        const current = placeholder({ id: 'unmatched' })
        const entries = [current]

        const result = migrateLoremasterDisabledEntries(entries, {})

        expect(result).toEqual({
            entries: [current],
            changed: false,
            restoredIds: [],
        })
        expect(result.entries).toBe(entries)
        expect(result.entries[0]).toBe(current)
    })

    it('is idempotent while legacy backups remain available', () => {
        const backups = { 'lore-1': backup() }
        const first = migrateLoremasterDisabledEntries([placeholder()], backups)

        const second = migrateLoremasterDisabledEntries(first.entries, backups)

        expect(second).toEqual({
            entries: first.entries,
            changed: false,
            restoredIds: [],
        })
        expect(second.entries).toBe(first.entries)
        expect(second.entries[0]).toBe(first.entries[0])
    })

    it('preserves unrelated entry identities when another entry is restored', () => {
        const untouched = placeholder({ id: 'untouched', disabled: undefined })
        const restored = placeholder()

        const result = migrateLoremasterDisabledEntries(
            [untouched, restored],
            { 'lore-1': backup() },
        )

        expect(result.entries[0]).toBe(untouched)
        expect(result.entries[1]).not.toBe(restored)
    })

    it('safely ignores malformed and payload-ID-mismatched backups', () => {
        const entries = [
            placeholder({ id: 'null-backup' }),
            placeholder({ id: 'partial-backup' }),
            placeholder({ id: 'mismatched-backup' }),
        ]
        const backups = {
            'null-backup': null,
            'partial-backup': { id: 'partial-backup', content: 'Only content' },
            'mismatched-backup': backup({ id: 'different-id' }),
        } as unknown as Record<string, LegacyEntry>

        const result = migrateLoremasterDisabledEntries(entries, backups)

        expect(result.changed).toBe(false)
        expect(result.entries).toBe(entries)
        expect(result.restoredIds).toEqual([])
    })

    it('does not restore duplicate current stable IDs', () => {
        const first = placeholder({ comment: '[X] First' })
        const second = placeholder({ comment: '[X] Second' })
        const entries = [first, second]

        const result = migrateLoremasterDisabledEntries(entries, { 'lore-1': backup() })

        expect(result.changed).toBe(false)
        expect(result.entries).toBe(entries)
        expect(result.entries).toEqual([first, second])
        expect(result.restoredIds).toEqual([])
    })
})
