import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { readFileSync } from 'node:fs'
import SettingPage from './SettingPage.svelte'
import ManagerResizeHandles from './ManagerResizeHandles.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
})

async function manager() {
    const host = document.body.appendChild(document.createElement('div'))
    Object.defineProperty(host, 'clientWidth', { value: 1000 })
    mounted = mount(SettingPage, { target: host, props: { title: 'Modules', resizable: true } })
    await tick()
    const page = host.querySelector<HTMLElement>('[data-settings-page]')!
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON() {} })
    const handle = page.querySelector<HTMLElement>('[data-manager-window-resize="se"]')
    expect(handle, 'resizable managers expose a visible corner handle').not.toBeNull()
    return { host, page, handle: handle! }
}

describe('manager window resize controls', () => {
    test('keeps ordinary settings pages unchanged', async () => {
        mounted = mount(SettingPage, { target: document.body, props: { title: 'Normal' } })
        await tick()
        expect(document.querySelector('[data-manager-window-resize]')).toBeNull()
    })

    test('resizes an inline manager with the keyboard and resets with Home', async () => {
        const { page, handle } = await manager()
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(page.style.getPropertyValue('--manager-width')).toBe('816px')
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
        expect(page.style.getPropertyValue('--manager-height')).toBe('548px')
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        expect(page.style.getPropertyValue('--manager-width')).toBe('')
        expect(page.style.getPropertyValue('--manager-height')).toBe('')
    })

    test('bounds pointer resizing to the parent and viewport and cleans up after cancellation', async () => {
        const { page, handle } = await manager()
        handle.setPointerCapture = vi.fn()
        handle.hasPointerCapture = vi.fn(() => true)
        handle.releasePointerCapture = vi.fn()
        handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, clientX: 800, clientY: 500, bubbles: true }))
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 3000, clientY: 3000 }))
        expect(parseFloat(page.style.getPropertyValue('--manager-width'))).toBe(1000)
        expect(parseFloat(page.style.getPropertyValue('--manager-height'))).toBeLessThanOrEqual(window.innerHeight - 16)
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3 }))
        const saved = page.getAttribute('style')
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 0, clientY: 0 }))
        expect(page.getAttribute('style')).toBe(saved)
        expect(handle.releasePointerCapture).toHaveBeenCalledWith(3)
        handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        expect(page.style.getPropertyValue('--manager-width')).toBe('')
    })

    test('removes active drag listeners on unmount', async () => {
        const { page, handle } = await manager()
        handle.setPointerCapture = vi.fn()
        handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 4, clientX: 800, bubbles: true }))
        await unmount(mounted!)
        mounted = undefined
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: 900 }))
        expect(page.style.getPropertyValue('--manager-width')).toBe('')
    })

    test('resizes centered dialogs from both sides without exceeding small viewports', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        target.getBoundingClientRect = () => ({ width: 800, height: 500 } as DOMRect)
        mounted = mount(ManagerResizeHandles, { target, props: { target, centered: true } })
        await tick()
        expect(target.querySelectorAll('[data-manager-window-resize]')).toHaveLength(8)
        const west = target.querySelector<HTMLElement>('[data-manager-window-resize="w"]')!
        west.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(target.style.getPropertyValue('--manager-width')).toBe('768px')
        vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(360)
        vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300)
        const corner = target.querySelector<HTMLElement>('[data-manager-window-resize="se"]')!
        corner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        corner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
        expect(target.style.getPropertyValue('--manager-width')).toBe('344px')
        expect(target.style.getPropertyValue('--manager-height')).toBe('284px')
    })

    test('uses 1.3x base widths only for the requested managers', () => {
        const settingPage = readFileSync('src/lib/UI/GUI/SettingPage.svelte', 'utf8')
        const settings = readFileSync('src/lib/Setting/Settings.svelte', 'utf8')
        const presets = readFileSync('src/lib/Setting/botpreset.svelte', 'utf8')
        expect(settingPage).toContain('(var(--settings-content-width, 58rem) - 2 * var(--settings-page-gutter, 0rem)) * 1.3')
        expect(settings).toContain('settings-page--collection')
        expect(settings).toContain('.settings-page.settings-page--collection:has(:global(.settings-standard-page--resizable))')
        expect(presets).toContain('83.2rem')
        expect(presets).toContain('<ManagerResizeHandles')
        expect(presets).toContain('<ShDialog')
    })

    test('keeps preset comparison inside the dialog focus and pointer scope', () => {
        const presets = readFileSync('src/lib/Setting/botpreset.svelte', 'utf8')
        expect(presets.indexOf('<PromptDiffModal')).toBeLessThan(presets.indexOf('</ShDialog>'))
    })
})
