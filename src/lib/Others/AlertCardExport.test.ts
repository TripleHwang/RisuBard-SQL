// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { readFileSync } from 'node:fs'

vi.mock('src/ts/process/modules', () => ({ moduleUpdate: vi.fn() }))

import AlertComp from './AlertComp.svelte'
import {
    alertStore,
    DBState,
    isTouchDevice,
    selectedCharID,
} from 'src/ts/stores.svelte'

let mounted: ReturnType<typeof mount> | undefined

async function renderCardExport() {
    DBState.db = {
        characters: [{ name: 'Export target', chaId: 'character-1', chats: [] }],
        botPresets: [],
        botPresetsId: 0,
        language: 'en',
    } as typeof DBState.db
    selectedCharID.set(0)
    isTouchDevice.set(false)
    alertStore.set({ type: 'none', msg: '' })

    const target = document.body.appendChild(document.createElement('div'))
    mounted = mount(AlertComp, { target })
    await tick()
    alertStore.set({ type: 'cardexport', msg: '', submsg: '' })
    await tick()
}

function button(label: string) {
    const match = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((entry) => entry.textContent?.trim() === label)
    if (!match) throw new Error(`Missing button: ${label}`)
    return match
}

describe('character card export dialog', () => {
    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
        alertStore.set({ type: 'none', msg: '' })
    })

    test('changes card version and exports the selected format', async () => {
        await renderCardExport()

        button('Character Card V2').click()
        await tick()
        expect(button('Character Card V2').classList.contains('ring-1')).toBe(true)
        expect(document.body.querySelector('[role="combobox"]')).toBeNull()

        button('Character Card V3').click()
        await tick()
        expect(button('Character Card V3').classList.contains('ring-1')).toBe(true)

        const format = document.body.querySelector<HTMLElement>('[role="combobox"]')!
        expect(format).not.toBeNull()
        format.click()
        await tick()
        button('JSON').click()
        await tick()

        button('Export').click()
        await tick()
        expect(JSON.parse(get(alertStore).msg)).toEqual({ type: '', type2: 'json' })
    })

    test('uses the alert dialog tier so no existing modal can intercept its controls', () => {
        const source = readFileSync('src/lib/Others/AlertComp.svelte', 'utf8')
        const start = source.indexOf("$alertStore.type === 'cardexport'")
        const end = source.indexOf("$alertStore.type === 'selectModule'", start)
        const cardExport = source.slice(start, end)

        expect(cardExport).toContain('<ShDialog')
        expect(cardExport).toContain('tier="alert"')
        expect(cardExport).not.toContain('z-50')
    })
})
