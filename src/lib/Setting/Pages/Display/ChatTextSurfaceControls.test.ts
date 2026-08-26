import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme'
import { saveImage } from 'src/ts/storage/database.svelte'
import { selectSingleFile } from 'src/ts/util'
import { displayThemeSettingsItems } from 'src/ts/setting/displaySettingsData.svelte'
import NullableTextColorToggle from './NullableTextColorToggle.svelte'
import CustomBackgroundToggle from './CustomBackgroundToggle.svelte'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} } }))
vi.mock('src/ts/gui/colorscheme', () => ({ updateTextThemeAndCSS: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({ saveImage: vi.fn() }))
vi.mock('src/ts/globalApi.svelte', () => ({ getFileSrc: vi.fn(async () => '') }))
vi.mock('src/ts/util', () => ({ selectSingleFile: vi.fn(), changeFullscreen: vi.fn() }))
vi.mock('src/ts/gui/animation', () => ({ updateAnimationSpeed: vi.fn() }))
vi.mock('src/ts/gui/guisize', () => ({ updateGuisize: vi.fn() }))
vi.mock('src/lang', () => ({ language: { help: {}, select: 'Select', edit: 'Edit', remove: 'Remove' } }))

let mounted: ReturnType<typeof mount> | undefined
beforeEach(() => {
    vi.clearAllMocks()
    DBState.db = { textScreenColor: '#121212', customBackground: '' } as typeof DBState.db
})
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('chat surface setting updates', () => {
    test('refreshes contrast immediately after changing the backdrop color', async () => {
        mounted = mount(NullableTextColorToggle, {
            target: document.body,
            props: { field: 'textScreenColor', labelKey: 'textBackgrounds', defaultColor: '#121212' },
        })
        await tick()
        expect(updateTextThemeAndCSS).not.toHaveBeenCalled()
        const input = document.querySelector<HTMLInputElement>('input[type="color"]')!
        input.value = '#ffffff'
        input.dispatchEvent(new Event('input', { bubbles: true }))

        expect(DBState.db.textScreenColor).toBe('#ffffff')
        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })

    test('refreshes contrast immediately after disabling the backdrop color', async () => {
        mounted = mount(NullableTextColorToggle, {
            target: document.body,
            props: { field: 'textScreenColor', labelKey: 'textBackgrounds', defaultColor: '#121212' },
        })
        await tick()
        document.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
        await tick()

        expect(DBState.db.textScreenColor).toBeNull()
        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })

    test('refreshes contrast after removing the image that activated the backdrop', async () => {
        DBState.db.customBackground = 'assets/background.webp'
        mounted = mount(CustomBackgroundToggle, { target: document.body })
        await tick()
        document.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click()

        expect(DBState.db.customBackground).toBe('')
        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })

    test('refreshes contrast after choosing a background image', async () => {
        vi.mocked(selectSingleFile).mockResolvedValue({ name: 'background.webp', data: new Uint8Array() })
        vi.mocked(saveImage).mockResolvedValue('assets/background.webp')
        mounted = mount(CustomBackgroundToggle, { target: document.body })
        await tick()
        document.querySelector<HTMLButtonElement>('button')!.click()

        await vi.waitFor(() => expect(DBState.db.customBackground).toBe('assets/background.webp'))
        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })

    test('refreshes contrast when the chat view changes', () => {
        const item = displayThemeSettingsItems.find((item) => item.id === 'display.theme')!
        item.onChange?.('waifu', { db: DBState.db } as never)

        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })
})
