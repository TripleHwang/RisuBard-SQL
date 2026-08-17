// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import type { loreBook } from 'src/ts/storage/database.svelte'
import { languageEnglish } from 'src/lang/en'
import LoreBookWorkspace from './LoreBookWorkspace.svelte'
import LoreBookWorkspaceDialog from './LoreBookWorkspaceDialog.svelte'
import { createLorebookOwnerBinding } from './loreBookWorkspaceConnections'
import { clearLorebookWorkspaceSessions } from './loreBookWorkspaceSession'

const sortableMock = vi.hoisted(() => ({
    options: undefined as Record<string, (...args: any[]) => unknown> | undefined,
    create: vi.fn(),
    instances: [] as Array<{ destroy: ReturnType<typeof vi.fn> }>,
}))

const operationMocks = vi.hoisted(() => ({
    applyBatchPatch: vi.fn(),
}))

const environmentMock = vi.hoisted(() => ({
    mobile: false,
    db: { disableMobileDragDrop: false },
    listeners: new Set<(event: MediaQueryListEvent) => void>(),
    alertConfirm: vi.fn<(message: string) => Promise<boolean>>(async () => true),
    notifySuccess: vi.fn<(message: string) => void>(),
}))

vi.mock('sortablejs', () => ({
    default: {
        create: vi.fn((_element: HTMLElement, options: Record<string, (...args: any[]) => unknown>) => {
            sortableMock.options = options
            sortableMock.create(_element, options)
            const instance = { destroy: vi.fn() }
            sortableMock.instances.push(instance)
            return instance
        }),
    },
}))

vi.mock('src/ts/lorebook/workspaceOperations', async (importOriginal) => {
    const actual = await importOriginal<typeof import('src/ts/lorebook/workspaceOperations')>()
    operationMocks.applyBatchPatch.mockImplementation(actual.applyBatchPatch)
    return { ...actual, applyBatchPatch: operationMocks.applyBatchPatch }
})

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: environmentMock.db },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: environmentMock.alertConfirm,
    notifySuccess: environmentMock.notifySuccess,
}))

const entry = (id: string, patch: Partial<loreBook> = {}): loreBook => ({
    id,
    key: id,
    secondkey: '',
    insertorder: 100,
    comment: id,
    content: `content:${id}`,
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    ...patch,
})

let mounted: ReturnType<typeof mount> | undefined

function setMobileViewport(matches: boolean) {
    environmentMock.mobile = matches
    for (const listener of environmentMock.listeners) {
        listener({ matches } as MediaQueryListEvent)
    }
}

async function render(
    entries: loreBook[],
    props: Partial<{
        dragEnabled: boolean
        legacyDisabledBackups: Record<string, loreBook & { disabled?: boolean }>
        onChange: (next: loreBook[]) => void
        resolveChildLabel: (id: string) => string | undefined
        localActivation: {
            visible: boolean
            isActive: (entry: loreBook) => boolean
            onToggle: (entry: loreBook, active: boolean) => void
            onEntriesRemoved?: (ids: string[]) => void
        }
        scopeLabel: string
        scopeKey: string
    }> = {},
) {
    const target = document.body.appendChild(document.createElement('div'))
    const onChange = props.onChange ?? vi.fn()
    mounted = mount(LoreBookWorkspace, {
        target,
        props: {
            entries,
            scopeLabel: 'Character lore',
            onChange,
            ...props,
        },
    })
    await tick()
    return onChange
}

function click(selector: string) {
    const control = document.body.querySelector<HTMLElement>(selector)
    if (!control) throw new Error(`Missing control: ${selector}`)
    control.click()
}

function rect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        height: bottom - top,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: top,
        toJSON: () => ({}),
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    clearLorebookWorkspaceSessions()
    environmentMock.mobile = false
    environmentMock.db.disableMobileDragDrop = false
    environmentMock.alertConfirm.mockResolvedValue(true)
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn((query: string) => ({
            media: query,
            get matches() {
                return query.includes('max-width')
                    ? environmentMock.mobile
                    : !environmentMock.mobile
            },
            onchange: null,
            addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
                environmentMock.listeners.add(listener)
            },
            removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
                environmentMock.listeners.delete(listener)
            },
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => true,
        })),
    })
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
    sortableMock.options = undefined
    sortableMock.instances = []
    environmentMock.listeners.clear()
})

describe('LoreBookWorkspace', () => {
    it('renders the list, editor, and search together', async () => {
        await render([entry('one')])

        expect(document.body.querySelector('[data-lorebook-list]')).not.toBeNull()
        expect(document.body.querySelector('[data-lorebook-editor]')).not.toBeNull()
        expect(document.body.querySelector('[data-lorebook-search]')).not.toBeNull()
    })

    it('persists missing and duplicate IDs once when mounted', async () => {
        const onChange = vi.fn()
        await render([
            entry('', { comment: 'Missing', content: 'missing full text' }),
            entry('duplicate', { comment: 'First duplicate' }),
            entry('duplicate', { comment: 'Second duplicate' }),
        ], { onChange })
        await tick()

        expect(onChange).toHaveBeenCalledTimes(1)
        const normalized = onChange.mock.calls[0][0] as loreBook[]
        const ids = normalized.map((item) => item.id)
        expect(ids.every(Boolean)).toBe(true)
        expect(new Set(ids).size).toBe(3)
        expect(normalized[0]).toMatchObject({ comment: 'Missing', content: 'missing full text' })

        await tick()
        expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('creates folders with the established private-use key prefix', async () => {
        const onChange = vi.fn()
        await render([], { onChange })

        click('[data-lorebook-add-folder]')
        await tick()

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed).toHaveLength(1)
        expect(changed[0]).toMatchObject({ mode: 'folder' })
        expect(changed[0].key).toMatch(/^\uf000folder:/u)
    })

    it('routes a single editor commit through the pure batch patch operation', async () => {
        await render([entry('one', { comment: 'Before', content: 'preserved' })])
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        const name = document.body.querySelector<HTMLInputElement>('.editor-heading input')!
        name.value = 'After'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        name.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
        await tick()

        expect(operationMocks.applyBatchPatch).toHaveBeenCalledWith(
            expect.any(Array),
            new Set(['one']),
            { comment: 'After' },
        )
    })

    it('preserves a dirty active draft when a batch enabled change happens before blur', async () => {
        const onChange = vi.fn()
        await render([entry('one', { content: 'before' })], { onChange })
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        const content = document.body.querySelector<HTMLTextAreaElement>('.lore-content')!
        content.value = 'dirty draft'
        content.dispatchEvent(new Event('input', { bubbles: true }))
        click('[data-lorebook-batch-enabled="false"]')
        await tick()
        content.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
        await tick()

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed[0]).toMatchObject({ id: 'one', enabled: false, content: 'dirty draft' })
    })

    it('resynchronizes an active restored Loremaster entry before a later blur', async () => {
        const placeholder = entry('one', {
            comment: '[X] Library',
            key: '',
            content: '',
            folder: '\uf000folder:places',
            insertorder: 30,
        }) as loreBook & { disabled?: boolean }
        placeholder.disabled = true
        const onChange = vi.fn()
        await render([placeholder], {
            legacyDisabledBackups: {
                one: entry('one', { comment: 'Library', key: 'books', content: 'Full text' }),
            },
            onChange,
        })
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()
        click('[data-lorebook-import-loremaster]')
        await tick()

        const name = document.body.querySelector<HTMLInputElement>('[data-lorebook-field="comment"]')!
        expect(name.value).toBe('Library')
        name.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
        await tick()

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed[0]).toMatchObject({
            comment: 'Library', key: 'books', content: 'Full text', enabled: false,
        })
    })

    it('disables two checked entries without dropping their content', async () => {
        const entries = [
            entry('one', { content: 'one full text', bookVersion: 3 }),
            entry('two', { content: 'two full text', activationPercent: 45 }),
        ]
        const onChange = vi.fn()
        await render(entries, { onChange })

        click('[data-lorebook-select="one"]')
        click('[data-lorebook-select="two"]')
        await tick()
        click('[data-lorebook-batch-enabled="false"]')
        await tick()

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed).toEqual([
            expect.objectContaining({ id: 'one', enabled: false, content: 'one full text', bookVersion: 3 }),
            expect.objectContaining({ id: 'two', enabled: false, content: 'two full text', activationPercent: 45 }),
        ])
    })

    it('keeps the mobile checkbox inside a separate accessible hit area', async () => {
        setMobileViewport(true)
        await render([entry('one', { comment: 'Library' })])

        const hitArea = document.body.querySelector<HTMLLabelElement>('.row-select-hit-area')
        const checkbox = hitArea?.querySelector<HTMLInputElement>('[data-lorebook-select="one"]')
        expect(hitArea).not.toBeNull()
        expect(checkbox?.getAttribute('aria-label')).toBe('Select Library')
    })

    it('keeps a key-matching child and its folder in search results', async () => {
        await render([
            entry('folder', { mode: 'folder', key: 'places', comment: 'Places' }),
            entry('library', { key: 'books, archive', folder: 'places', comment: 'Library' }),
            entry('other', { key: 'weather', comment: 'Weather' }),
        ])

        const target = document.body.querySelector<HTMLSelectElement>('[data-lorebook-search-target]')!
        target.value = 'keys'
        target.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        const search = document.body.querySelector<HTMLInputElement>('[data-lorebook-search]')!
        search.value = 'archive'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        const list = document.body.querySelector('[data-lorebook-list]')!
        expect(list.textContent).toContain('Places')
        expect(list.textContent).toContain('Library')
        expect(list.textContent).not.toContain('Weather')
    })

    it('keeps every explicit move action when drag is disabled', async () => {
        await render([
            entry('folder', { mode: 'folder', key: 'places', comment: 'Places' }),
            entry('one'),
        ], { dragEnabled: false })

        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        for (const action of ['up', 'down', 'folder', 'root']) {
            expect(document.body.querySelector(`[data-lorebook-move="${action}"]`)).not.toBeNull()
        }
    })

    it('separates folder disclosure from editing and exposes folder management without drag', async () => {
        const folderKey = '\uf000folder:places'
        const onChange = vi.fn()
        await render([
            entry('folder', { mode: 'folder', key: folderKey, comment: 'Places', insertorder: 10 }),
            entry('child', { folder: folderKey, comment: 'Library', insertorder: 20 }),
            entry('folder-two', { mode: 'folder', key: '\uf000folder:people', comment: 'People', insertorder: 30 }),
        ], { dragEnabled: false, onChange })

        const folderRow = document.body.querySelector<HTMLElement>('[data-lorebook-row="folder"]')!
        expect(folderRow.getAttribute('role')).toBeNull()
        const disclosure = folderRow.querySelector<HTMLButtonElement>('[data-lorebook-folder-toggle]')!
        expect(disclosure.getAttribute('aria-expanded')).toBe('false')
        expect(document.body.querySelector('[data-lorebook-row="child"]')).toBeNull()
        disclosure.click()
        await tick()
        expect(disclosure.getAttribute('aria-expanded')).toBe('true')
        expect(document.body.querySelector('[data-lorebook-row="child"]')).not.toBeNull()
        expect(document.body.querySelector('[data-lorebook-folder-editor]')).toBeNull()

        click('[data-lorebook-row="folder"] [data-lorebook-folder-edit]')
        await tick()
        const name = document.body.querySelector<HTMLInputElement>('[data-lorebook-folder-name]')!
        name.value = 'Locations'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        name.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
        await tick()
        expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({ comment: 'Locations' })
        expect(document.body.querySelector('[data-lorebook-move="up"]')).not.toBeNull()
        click('[data-lorebook-move="down"]')
        await tick()
        expect((onChange.mock.calls.at(-1)?.[0] as loreBook[]).map((item) => item.id))
            .toEqual(['folder-two', 'folder', 'child'])
    })

    it('renders child-mode lore as a disabled global link and restores activation percent for normal lore', async () => {
        const onChange = vi.fn()
        await render([
            entry('link', { mode: 'child', comment: 'Global library', content: 'do not edit' }),
            entry('normal', { activationPercent: 42 }),
        ], { onChange })

        click('[data-lorebook-row="link"] [data-lorebook-open]')
        await tick()
        expect(document.body.querySelector('[data-lorebook-child-link]')).not.toBeNull()
        expect(document.body.querySelector('[data-lorebook-child-link] textarea')).toBeNull()
        expect(document.body.querySelector('[data-lorebook-child-link] input:not([disabled])')).toBeNull()

        click('[data-lorebook-row="normal"] [data-lorebook-open]')
        await tick()
        const activation = document.body.querySelector<HTMLInputElement>('[data-lorebook-activation-percent]')!
        expect(activation.value).toBe('42')
        activation.value = '55'
        activation.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        expect(onChange.mock.calls.at(-1)?.[0][1]).toMatchObject({ activationPercent: 55 })
    })

    it('shows current-chat activation only when enabled and routes the active normal entry', async () => {
        const onToggle = vi.fn()
        await render([entry('one')], {
            localActivation: {
                visible: true,
                isActive: (item) => item.id === 'one',
                onToggle,
            },
        })
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        const checkbox = document.body.querySelector<HTMLInputElement>('[data-lorebook-local-activation]')!
        expect(checkbox).not.toBeNull()
        expect(checkbox.checked).toBe(true)
        checkbox.checked = false
        checkbox.dispatchEvent(new Event('change', { bubbles: true }))
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }), false)
    })

    it('hides current-chat activation when the setting is disabled', async () => {
        await render([entry('one')], {
            localActivation: {
                visible: false,
                isActive: () => false,
                onToggle: vi.fn(),
            },
        })
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        expect(document.body.querySelector('[data-lorebook-local-activation]')).toBeNull()
    })

    it('reports every entry removed by a cascading folder deletion', async () => {
        const onEntriesRemoved = vi.fn()
        await render([
            entry('folder', { mode: 'folder', key: '\uf000folder:places' }),
            entry('inside', { folder: '\uf000folder:places' }),
            entry('unrelated'),
        ], {
            localActivation: {
                visible: true,
                isActive: () => false,
                onToggle: vi.fn(),
                onEntriesRemoved,
            },
        })
        click('[data-lorebook-row="folder"] [data-lorebook-folder-edit]')
        await tick()
        click('[data-lorebook-delete]')
        await vi.waitFor(() => expect(onEntriesRemoved).toHaveBeenCalledTimes(1))

        expect(new Set(onEntriesRemoved.mock.calls[0][0])).toEqual(new Set(['folder', 'inside']))
    })

    it('finishes a deferred deletion against the captured scope after a scope switch', async () => {
        const confirmation = deferred<boolean>()
        environmentMock.alertConfirm.mockReturnValueOnce(confirmation.promise)
        const onChangeA = vi.fn()
        const onChangeB = vi.fn()
        const activationA = {
            visible: true,
            isActive: () => false,
            onToggle: vi.fn(),
            onEntriesRemoved: vi.fn(),
        }
        const activationB = {
            visible: true,
            isActive: () => false,
            onToggle: vi.fn(),
            onEntriesRemoved: vi.fn(),
        }
        const target = document.body.appendChild(document.createElement('div'))
        const component = createClassComponent({
            component: LoreBookWorkspace,
            target,
            props: {
                entries: [entry('scope-a-entry')],
                scopeLabel: 'Scope A',
                scopeKey: 'scope-a',
                onChange: onChangeA,
                localActivation: activationA,
            },
        })
        try {
            click('[data-lorebook-row="scope-a-entry"] [data-lorebook-open]')
            await tick()
            click('[data-lorebook-delete]')
            await vi.waitFor(() => expect(environmentMock.alertConfirm).toHaveBeenCalledTimes(1))

            component.$set({
                entries: [entry('scope-b-entry')],
                scopeLabel: 'Scope B',
                scopeKey: 'scope-b',
                onChange: onChangeB,
                localActivation: activationB,
            })
            await tick()
            confirmation.resolve(true)
            await vi.waitFor(() => expect(onChangeA).toHaveBeenCalledWith([]))

            expect(onChangeB).not.toHaveBeenCalled()
            expect(activationA.onEntriesRemoved).toHaveBeenCalledWith(['scope-a-entry'])
            expect(activationB.onEntriesRemoved).not.toHaveBeenCalled()
        }
        finally {
            component.$destroy()
        }
    })

    it('keeps Ctrl/Cmd selection limited to editable normal lore and batch ops leave child links intact', async () => {
        const child = entry('link', { mode: 'child', content: 'linked record' })
        const onChange = vi.fn()
        await render([
            entry('normal'),
            child,
            entry('folder', { mode: 'folder', key: '\uf000folder:places' }),
        ], { onChange })

        for (const id of ['normal', 'link', 'folder']) {
            document.body.querySelector<HTMLElement>(`[data-lorebook-row="${id}"] .row-main`)!
                .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
            await tick()
        }

        expect(document.body.querySelector('[data-lorebook-row="normal"]')?.classList.contains('selected')).toBe(true)
        expect(document.body.querySelector('[data-lorebook-row="link"]')?.classList.contains('selected')).toBe(false)
        expect(document.body.querySelector('[data-lorebook-row="folder"]')?.classList.contains('selected')).toBe(false)
        expect(document.body.querySelector('[data-lorebook-batch]')?.textContent).toContain('1 selected')
        click('[data-lorebook-batch-enabled="false"]')
        await tick()
        expect((onChange.mock.calls.at(-1)?.[0] as loreBook[])[1]).toBe(child)
    })

    it('uses desktop file-manager selection gestures and exposes a clear-selection action', async () => {
        await render([entry('a'), entry('b'), entry('c'), entry('d')], {
            scopeKey: 'desktop-selection-gestures',
        })

        document.body.querySelector<HTMLElement>('[data-lorebook-row="a"] .row-main')!.click()
        await tick()
        expect(document.body.querySelector('[data-lorebook-row="a"]')?.classList.contains('selected')).toBe(true)

        document.body.querySelector<HTMLElement>('[data-lorebook-row="c"] .row-main')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
        await tick()
        expect(document.body.querySelector('[data-lorebook-batch]')?.textContent).toContain('2 selected')

        document.body.querySelector<HTMLInputElement>('[data-lorebook-select="d"]')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
        await tick()
        expect(document.body.querySelector('[data-lorebook-row="c"]')?.classList.contains('selected')).toBe(true)
        expect(document.body.querySelector('[data-lorebook-row="d"]')?.classList.contains('selected')).toBe(true)

        click('[data-lorebook-clear-selection]')
        await tick()
        expect(document.body.querySelector('[data-lorebook-batch]')).toBeNull()
        expect(document.body.querySelectorAll('[data-lorebook-row].selected')).toHaveLength(0)
    })

    it('never renders private folder keys and uses the requested Solar disclosure icons', async () => {
        const privateKey = '\uf000folder:7ae21525-a9e7-4d3e-b543-7b8a4fb5d04e'
        await render([
            entry('folder', { mode: 'folder', key: privateKey, comment: 'Places' }),
            entry('child', { folder: privateKey, comment: 'Cafe' }),
        ], { scopeKey: 'folder-privacy' })

        expect(document.body.textContent).not.toContain(privateKey)
        expect(document.body.querySelector('[data-solar-icon="square-alt-arrow-right-bold"]')).not.toBeNull()
        click('[data-lorebook-folder-toggle]')
        await tick()
        expect(document.body.querySelector('[data-solar-icon="square-alt-arrow-down-bold"]')).not.toBeNull()
        click('[data-lorebook-folder-edit]')
        await tick()
        expect(document.body.textContent).not.toContain(privateKey)
    })

    it('restores the active selection, expanded folders, list scroll, and focused field after remount', async () => {
        const folderKey = '\uf000folder:session'
        const entries = [
            entry('folder', { mode: 'folder', key: folderKey, comment: 'Places' }),
            entry('inside', { folder: folderKey, comment: 'Cafe' }),
        ]
        await render(entries, { scopeKey: 'session-restore-test' })
        click('[data-lorebook-folder-toggle]')
        await tick()
        document.body.querySelector<HTMLElement>('[data-lorebook-row="inside"] .row-main')!.click()
        await tick()
        const list = document.body.querySelector<HTMLElement>('[data-lorebook-list] .lore-rows')!
        list.scrollTop = 87
        document.body.querySelector<HTMLTextAreaElement>('[data-lorebook-field="content"]')!.focus()

        await unmount(mounted!)
        mounted = undefined
        document.body.replaceChildren()
        await render(entries, { scopeKey: 'session-restore-test' })
        await vi.waitFor(() => expect(document.activeElement)
            .toBe(document.body.querySelector('[data-lorebook-field="content"]')))

        expect(document.body.querySelector('[data-lorebook-row="inside"]')?.classList.contains('active')).toBe(true)
        expect(document.body.querySelector('[data-lorebook-row="inside"]')?.classList.contains('selected')).toBe(true)
        expect(document.body.querySelector('[data-lorebook-folder-toggle]')?.getAttribute('aria-expanded')).toBe('true')
        expect(document.body.querySelector<HTMLElement>('[data-lorebook-list] .lore-rows')?.scrollTop).toBe(87)
    })

    it('identifies child links through the resolver and deactivates only after confirmation', async () => {
        const onChange = vi.fn()
        environmentMock.alertConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        await render([entry('global-id', { mode: 'child', comment: '', key: '' })], {
            onChange,
            resolveChildLabel: (id) => id === 'global-id' ? 'Global Library' : undefined,
        })

        const childRow = document.body.querySelector('[data-lorebook-row="global-id"] .row-main')!
        expect(childRow.querySelector('strong')?.textContent).toContain('Global Library')
        expect(childRow.querySelector('small')?.textContent).toContain('Global Library')
        click('[data-lorebook-row="global-id"] [data-lorebook-open]')
        await tick()
        expect(document.body.querySelector('[data-lorebook-child-label]')?.textContent).toContain('Global Library')
        click('[data-lorebook-deactivate-child]')
        await vi.waitFor(() => expect(environmentMock.alertConfirm).toHaveBeenCalledTimes(1))
        expect(onChange).not.toHaveBeenCalled()
        click('[data-lorebook-deactivate-child]')
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
    })

    it('uses the localized untitled label when a child resolver returns no label', async () => {
        await render(
            [entry('global-fallback', { mode: 'child', comment: '', key: '' })],
            { resolveChildLabel: () => '   ' },
        )
        expect(document.body.querySelector('[data-lorebook-row="global-fallback"] .row-main')?.textContent)
            .toContain(languageEnglish.lorebookWorkspace.untitledLore)
        click('[data-lorebook-row="global-fallback"] [data-lorebook-open]')
        await tick()
        expect(document.body.querySelector('[data-lorebook-child-label]')?.textContent)
            .toContain(languageEnglish.lorebookWorkspace.untitledLore)
    })

    it('includes the localized enabled state in each row action accessible name', async () => {
        await render([
            entry('on', { comment: 'On', enabled: true }),
            entry('off', { comment: 'Off', enabled: false }),
        ])

        expect(document.body.querySelector('[data-lorebook-row="on"] .row-main')?.textContent)
            .toContain(languageEnglish.lorebookWorkspace.enabled)
        expect(document.body.querySelector('[data-lorebook-row="off"] .row-main')?.textContent)
            .toContain(languageEnglish.lorebookWorkspace.disabled)
    })

    it('reconciles selection and editor state across same-scope entry replacement and scope changes', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        const ownerA = {
            data: [
                entry('same'),
                entry('removed'),
                entry('folder', { mode: 'folder', key: '\uf000folder:old' }),
                entry('other'),
            ],
        }
        const ownerB = {
            data: [
                entry('same', { content: 'scope-b content' }),
                entry('other'),
            ],
        }
        let liveOwner = ownerA
        const bindingForLiveOwner = () => {
            const owner = liveOwner
            return createLorebookOwnerBinding(
                owner,
                owner.data,
                (capturedOwner, next) => { capturedOwner.data = next },
            )
        }
        const bindingA = bindingForLiveOwner()
        const component = createClassComponent({
            component: LoreBookWorkspace,
            target,
            props: {
                entries: bindingA.entries,
                scopeLabel: 'Scope A',
                scopeKey: 'scope-a',
                onChange: bindingA.onChange,
            },
        })
        try {
            click('[data-lorebook-select="same"]')
            click('[data-lorebook-row="removed"] [data-lorebook-open]')
            await tick()
            const folderTarget = document.body.querySelector<HTMLSelectElement>('[aria-label="Move target folder"]')!
            folderTarget.value = 'folder'
            folderTarget.dispatchEvent(new Event('change', { bubbles: true }))

            ownerA.data = [
                entry('same'),
                entry('new-folder', { mode: 'folder', key: '\uf000folder:new' }),
                entry('other'),
            ]
            component.$set({ entries: ownerA.data })
            await tick()
            expect(document.body.querySelector('[data-lorebook-batch]')?.textContent).toContain('1 selected')
            expect(document.body.querySelector('.editor-empty')).not.toBeNull()

            click('[data-lorebook-row="same"] [data-lorebook-open]')
            await tick()
            expect(document.body.querySelector<HTMLSelectElement>('[aria-label="Move target folder"]')?.value).toBe('')
            const content = document.body.querySelector<HTMLTextAreaElement>('[data-lorebook-field="content"]')!
            content.value = 'scope-a draft'
            content.dispatchEvent(new Event('input', { bubbles: true }))

            liveOwner = ownerB
            const bindingB = bindingForLiveOwner()
            component.$set({
                entries: bindingB.entries,
                scopeLabel: 'Scope B',
                scopeKey: 'scope-b',
                onChange: bindingB.onChange,
            })
            await tick()
            expect(ownerA.data).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'same', content: 'scope-a draft' }),
            ]))
            expect(ownerB.data.find((item) => item.id === 'same')?.content).toBe('scope-b content')
            expect(document.body.querySelector('[data-lorebook-toolbar]')?.textContent).toContain('Scope B')
            expect(document.body.querySelector('[data-lorebook-batch]')).toBeNull()
            expect(document.body.querySelector('.editor-empty')).not.toBeNull()
            document.body.querySelector<HTMLElement>('[data-lorebook-row="other"] [data-lorebook-open]')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
            await tick()
            expect(document.body.querySelector('[data-lorebook-batch]')).toBeNull()
            click('[data-lorebook-row="same"] [data-lorebook-open]')
            await tick()
            expect(document.body.querySelector<HTMLTextAreaElement>('[data-lorebook-field="content"]')?.value)
                .toBe('scope-b content')
        }
        finally {
            component.$destroy()
        }
    })

    it('removes selected folder children from batch state after cascading folder deletion', async () => {
        const folderKey = '\uf000folder:places'
        const onChange = vi.fn()
        await render([
            entry('folder', { mode: 'folder', key: folderKey }),
            entry('child', { folder: folderKey }),
        ], { onChange })
        click('[data-lorebook-folder-toggle]')
        await tick()
        click('[data-lorebook-select="child"]')
        click('[data-lorebook-folder-edit]')
        await tick()
        click('[data-lorebook-delete]')

        await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
        await tick()
        expect(document.body.querySelector('[data-lorebook-batch]')).toBeNull()
    })

    it('requires confirmation before deleting and honors both cancel and accept', async () => {
        const onChange = vi.fn()
        environmentMock.alertConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        await render([entry('one', { comment: 'Archive', content: 'full text' })], { onChange })
        click('[data-lorebook-row="one"] [data-lorebook-open]')
        await tick()

        click('[data-lorebook-delete]')
        await vi.waitFor(() => expect(environmentMock.alertConfirm).toHaveBeenCalledTimes(1))
        expect(environmentMock.alertConfirm.mock.calls[0][0]).toContain('Archive')
        expect(onChange).not.toHaveBeenCalled()

        click('[data-lorebook-delete]')
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
    })

    it('states the folder child count in destructive confirmation', async () => {
        const folderKey = '\uf000folder:places'
        environmentMock.alertConfirm.mockResolvedValue(false)
        await render([
            entry('folder', { mode: 'folder', key: folderKey, comment: 'Places' }),
            entry('one', { folder: folderKey }),
            entry('two', { folder: folderKey }),
        ])
        click('[data-lorebook-row="folder"] [data-lorebook-folder-edit]')
        await tick()
        click('[data-lorebook-delete]')

        await vi.waitFor(() => expect(environmentMock.alertConfirm).toHaveBeenCalled())
        expect(environmentMock.alertConfirm.mock.calls[0][0]).toContain('2')
    })

    it('restores exact Loremaster backups as native disabled entries', async () => {
        const placeholder = entry('one', {
            comment: '[X] Library',
            key: '',
            content: '',
            folder: 'places',
            insertorder: 30,
        }) as loreBook & { disabled?: boolean }
        placeholder.disabled = true
        const backup = entry('one', {
            comment: 'Library',
            key: 'books',
            content: 'Full text',
            alwaysActive: true,
        })
        const onChange = vi.fn()
        await render([placeholder], {
            legacyDisabledBackups: { one: backup },
            onChange,
        })

        click('[data-lorebook-import-loremaster]')
        await tick()

        expect(onChange).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'one',
                comment: 'Library',
                key: 'books',
                content: 'Full text',
                folder: 'places',
                insertorder: 30,
                enabled: false,
            }),
        ])
        expect(onChange.mock.calls.at(-1)?.[0][0]).not.toHaveProperty('disabled')
    })

    it('uses the mouse onMove target even when onEnd points at the moved source', async () => {
        const onChange = vi.fn()
        await render([entry('a'), entry('b'), entry('c')], { onChange })
        const source = document.body.querySelector<HTMLElement>('[data-lorebook-row="c"]')!
        const target = document.body.querySelector<HTMLElement>('[data-lorebook-row="b"]')!
        const options = sortableMock.options!
        expect(options.onMove).toBeTypeOf('function')

        options.onStart?.({ item: source })
        options.onMove?.({
            dragged: source,
            related: target,
            relatedRect: rect(40, 80),
        }, new MouseEvent('mousemove', { clientY: 45 }))
        options.onEnd?.({ item: source, to: source.parentElement!, newIndex: 2 })

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed.map((item) => item.id)).toEqual(['a', 'c', 'b'])
    })

    it('uses touch coordinates and excludes a self-related row when resolving a folder drop', async () => {
        const folderKey = '\uf000folder:places'
        const onChange = vi.fn()
        await render([
            entry('a'),
            entry('folder', { mode: 'folder', key: folderKey, comment: 'Places' }),
        ], { onChange })
        const source = document.body.querySelector<HTMLElement>('[data-lorebook-row="a"]')!
        const folder = document.body.querySelector<HTMLElement>('[data-lorebook-row="folder"]')!
        folder.getBoundingClientRect = () => rect(40, 80)
        const options = sortableMock.options!
        expect(options.onMove).toBeTypeOf('function')

        options.onStart?.({ item: source })
        options.onMove?.({
            dragged: source,
            related: source,
            relatedRect: rect(0, 40),
        }, {
            touches: [{ clientY: 60 }],
            changedTouches: [{ clientY: 60 }],
        })
        options.onEnd?.({ item: source, to: source.parentElement!, newIndex: 0 })

        const changed = onChange.mock.calls.at(-1)?.[0] as loreBook[]
        expect(changed.map((item) => item.id)).toEqual(['folder', 'a'])
        expect(changed.find((item) => item.id === 'a')?.folder).toBe(folderKey)
    })

    it('destroys and recreates Sortable when viewport and mobile drag settings change', async () => {
        await render([entry('a'), entry('b')])
        expect(sortableMock.create).toHaveBeenCalledTimes(1)
        const first = sortableMock.instances[0]

        environmentMock.db.disableMobileDragDrop = true
        setMobileViewport(true)
        await tick()
        expect(first.destroy).toHaveBeenCalledTimes(1)
        expect(sortableMock.create).toHaveBeenCalledTimes(1)

        environmentMock.db.disableMobileDragDrop = false
        setMobileViewport(false)
        await tick()
        expect(sortableMock.create).toHaveBeenCalledTimes(2)
    })

    it('does not create Sortable when drag is disabled', async () => {
        await render([entry('a')], { dragEnabled: false })
        expect(sortableMock.create).not.toHaveBeenCalled()
    })

    it('restores Sortable DOM mutation before applying a valid pure data move', async () => {
        let domAtChange: string[] = []
        const onChange = vi.fn((_entries: loreBook[]) => {
            domAtChange = [...document.body.querySelectorAll<HTMLElement>('[data-lorebook-row]')]
                .map((row) => row.dataset.lorebookRow!)
        })
        await render([entry('a'), entry('b'), entry('c')], { onChange })
        const list = document.body.querySelector<HTMLElement>('.lore-rows')!
        const source = list.querySelector<HTMLElement>('[data-lorebook-row="c"]')!
        const target = list.querySelector<HTMLElement>('[data-lorebook-row="b"]')!
        const options = sortableMock.options!

        options.onStart?.({ item: source })
        options.onMove?.({ dragged: source, related: target, relatedRect: rect(40, 80) },
            new MouseEvent('mousemove', { clientY: 45 }))
        list.insertBefore(source, target)
        expect([...list.querySelectorAll<HTMLElement>('[data-lorebook-row]')]
            .map((row) => row.dataset.lorebookRow)).toEqual(['a', 'c', 'b'])
        options.onEnd?.({ item: source, to: list, newIndex: 1 })

        expect(domAtChange).toEqual(['a', 'b', 'c'])
        expect((onChange.mock.calls[0][0] as loreBook[]).map((item) => item.id))
            .toEqual(['a', 'c', 'b'])
    })

    it('restores Sortable DOM mutation even when no drop intent exists', async () => {
        const onChange = vi.fn()
        await render([entry('a'), entry('b'), entry('c')], { onChange })
        const list = document.body.querySelector<HTMLElement>('.lore-rows')!
        const source = list.querySelector<HTMLElement>('[data-lorebook-row="b"]')!
        const options = sortableMock.options!

        options.onStart?.({ item: source })
        list.insertBefore(source, list.firstElementChild)
        options.onEnd?.({ item: source, to: list, newIndex: 0 })

        expect([...list.querySelectorAll<HTMLElement>('[data-lorebook-row]')]
            .map((row) => row.dataset.lorebookRow)).toEqual(['a', 'b', 'c'])
        expect(onChange).not.toHaveBeenCalled()
    })
})

describe('LoreBookWorkspaceDialog source contract', () => {
    it('commits an active draft when the dialog closes and shows it after reopening', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        const entries = [entry('one')]
        const onChange = vi.fn((next: loreBook[]) => {
            entries.splice(0, entries.length, ...next)
        })
        const component = createClassComponent({
            component: LoreBookWorkspaceDialog,
            target,
            props: {
                open: true,
                entries,
                scopeKey: 'dialog-scope',
                scopeLabel: 'Dialog lore',
                onChange,
            },
        })
        try {
            await vi.waitFor(() => expect(document.body.querySelector('[data-lorebook-row="one"]')).not.toBeNull())
            click('[data-lorebook-row="one"] [data-lorebook-open]')
            await tick()
            const content = document.body.querySelector<HTMLTextAreaElement>('[data-lorebook-field="content"]')!
            content.value = 'saved on close'
            content.dispatchEvent(new Event('input', { bubbles: true }))

            component.$set({ open: false })
            await tick()
            expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({ id: 'one', content: 'saved on close' }),
            ]))

            component.$set({ open: true })
            await vi.waitFor(() => expect(document.body.querySelector('[data-lorebook-row="one"]')).not.toBeNull())
            click('[data-lorebook-row="one"] [data-lorebook-open]')
            await tick()
            expect(document.body.querySelector<HTMLTextAreaElement>('[data-lorebook-field="content"]')?.value)
                .toBe('saved on close')
        }
        finally {
            component.$destroy()
        }
    })

    it('declares the wide responsive shell and pointer splitter hooks', () => {
        const source = readFileSync(resolve(
            'src/lib/SideBars/LoreBook/LoreBookWorkspaceDialog.svelte',
        ), 'utf8')
        const workspaceSource = readFileSync(resolve(
            'src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte',
        ), 'utf8')

        expect(source).toContain('min(96vw, 1700px)')
        expect(source).toContain('min(92vh, 1000px)')
        expect(source).toContain('new MediaQuery(\'(min-width: 900px)\')')
        expect(source).toContain('data-lorebook-splitter')
        expect(source).toContain('pointermove')
        expect(source).toContain('setPointerCapture')
        expect(workspaceSource).toContain('--lore-list-width: clamp(26%, var(--lore-list-ratio, 38%), 52%)')
        expect(workspaceSource).toContain('--lore-effective-list-width: max(19rem, var(--lore-list-width, 38%))')
        expect(workspaceSource).toContain('minmax(19rem, var(--lore-list-width, 38%))')
        expect(workspaceSource).toContain('left: calc(var(--lore-effective-list-width) - .25rem)')
        expect(workspaceSource).toContain('container-name: lore-workbench')
        expect(workspaceSource).toContain('@container lore-workbench (max-width: 1199px)')
        expect(workspaceSource).not.toContain('@container (max-width: 31rem)')
        expect(workspaceSource).toContain('grid-template-rows: auto minmax(0, 1fr)')
        expect(workspaceSource).toContain('grid-column: 1 / -1')
        expect(workspaceSource).toContain('content-visibility: auto')
        expect(workspaceSource).toContain('contain-intrinsic-size: auto 3.05rem')
        expect(workspaceSource).toContain('touch-action: manipulation')
        expect(workspaceSource).toContain('scopeKey?: string')
        expect(source).toContain('scopeKey?: string')
        expect(source).toContain('{scopeKey}')
        expect(workspaceSource).toContain('[data-lorebook-drag-handle], .folder-disclosure, .row-select-hit-area')
        expect(workspaceSource).toContain('.row-select-hit-area { display: grid; min-width: 3rem; min-height: 3rem; place-items: center; }')
        expect(workspaceSource).toContain('[data-lorebook-select] { width: 1rem; min-width: 1rem; height: 1rem; min-height: 1rem; margin: 0; }')
        expect(workspaceSource).not.toContain('.folder-disclosure, [data-lorebook-select]')
        expect(source).not.toContain('lorebookWorkspace.description')
        expect(source).toContain('lore-dialog-close')
        expect(workspaceSource).toContain('square-alt-arrow-down-bold.svg')
        expect(workspaceSource).toContain('square-alt-arrow-right-bold.svg')
        expect(workspaceSource).toContain('document-add-bold.svg')
        expect(workspaceSource).toContain('add-folder-bold.svg')
        expect(workspaceSource).toContain('file-download-bold.svg')
        expect(workspaceSource).toContain('file-send-bold.svg')
    })

    it('keeps the content heading intrinsic and gives remaining height to the textarea', () => {
        const workspaceSource = readFileSync(resolve(
            'src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte',
        ), 'utf8')
        const contentFieldRule = workspaceSource.match(/\.content-field\s*\{([^}]*)\}/)?.[1]

        expect(contentFieldRule).toContain('grid-template-rows: auto minmax(0, 1fr)')
    })

    it('mounts pointer resize/reset handlers and removes them on teardown', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(LoreBookWorkspaceDialog, {
            target,
            props: {
                open: true,
                entries: [entry('one')],
                scopeLabel: 'Dialog lore',
                onChange: vi.fn(),
            },
        })
        await vi.waitFor(() => expect(document.body.querySelector('[data-lorebook-splitter]')).not.toBeNull())
        const shell = document.body.querySelector<HTMLElement>('.lore-workspace')!
        const splitter = document.body.querySelector<HTMLElement>('[data-lorebook-splitter]')!
        shell.getBoundingClientRect = () => ({ ...rect(0, 600), left: 0, right: 1000, width: 1000 })
        splitter.setPointerCapture = vi.fn()
        splitter.hasPointerCapture = vi.fn(() => true)
        splitter.releasePointerCapture = vi.fn()

        splitter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 380 }))
        splitter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 900 }))
        expect(splitter.setPointerCapture).toHaveBeenCalledWith(7)
        expect(shell.style.getPropertyValue('--lore-list-ratio')).toBe('52%')
        splitter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 100 }))
        expect(shell.style.getPropertyValue('--lore-list-ratio')).toBe('26%')
        splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        expect(shell.style.getPropertyValue('--lore-list-ratio')).toBe('38%')

        await unmount(mounted)
        mounted = undefined
        shell.style.setProperty('--lore-list-ratio', '31%')
        splitter.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 700 }))
        expect(shell.style.getPropertyValue('--lore-list-ratio')).toBe('31%')
    })
})
