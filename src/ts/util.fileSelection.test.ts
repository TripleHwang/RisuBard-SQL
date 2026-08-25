import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const notifyError = vi.hoisted(() => vi.fn())
const database = vi.hoisted(() => ({ current: {} as any }))

vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => database.current,
}))
vi.mock('./stores.svelte', () => ({
    selectedCharID: {
        subscribe: (run: (value: number) => void) => {
            run(-1)
            return () => {}
        },
    },
}))
vi.mock('./characters', () => ({ createBlankChar: () => ({}), getCharImage: vi.fn() }))
vi.mock('./platform', () => ({ isIOS: () => false }))
vi.mock('./alert', () => ({ notifyError }))
vi.mock('../lang', () => ({ language: { unsupportedFileType: 'Unsupported file type' } }))

const { getUserIconProtrait, selectSingleFile } = await import('./util')

describe('selectSingleFile', () => {
    beforeEach(() => {
        notifyError.mockReset()
        database.current = { allowAllExtentionFiles: false, characters: [] }
    })

    test('uses a valid persona when the stored selection is out of range', () => {
        database.current = {
            characters: [],
            personas: [
                { largePortrait: 'first.png' },
                { largePortrait: 'second.png' },
            ],
            selectedPersona: 99,
        }

        expect(getUserIconProtrait()).toBe('second.png')
    })

    afterEach(() => {
        vi.restoreAllMocks()
        document.body.replaceChildren()
    })

    function dispatchSelection(files: File[]) {
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
            Object.defineProperty(this, 'files', { configurable: true, value: files })
            this.dispatchEvent(new Event('change'))
        })
    }

    test('returns null quietly when the picker produces no file', async () => {
        dispatchSelection([])

        await expect(selectSingleFile(['json'])).resolves.toBeNull()
        expect(notifyError).not.toHaveBeenCalled()
    })

    test('returns null quietly when the picker is cancelled', async () => {
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
            this.dispatchEvent(new Event('cancel'))
        })

        await expect(selectSingleFile(['json'])).resolves.toBeNull()
        expect(notifyError).not.toHaveBeenCalled()
    })

    test('reports a filtered unsupported file and returns null', async () => {
        dispatchSelection([new File(['plain'], 'notes.txt', { type: 'text/plain' })])

        await expect(selectSingleFile(['json'])).resolves.toBeNull()
        expect(notifyError).toHaveBeenCalledWith('Unsupported file type (.json)')
    })

    test('returns the selected supported file bytes', async () => {
        dispatchSelection([new File(['{}'], 'data.json', { type: 'application/json' })])

        await expect(selectSingleFile(['json'])).resolves.toEqual({
            name: 'data.json',
            data: new Uint8Array([123, 125]),
        })
        expect(notifyError).not.toHaveBeenCalled()
    })
})
