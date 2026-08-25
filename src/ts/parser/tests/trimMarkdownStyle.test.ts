import { describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ returnCSSError: false }))

vi.mock('../../storage/database.svelte', () => ({
    appVer: 'test',
    getCurrentCharacter: () => ({}),
    getDatabase: () => ({}),
}) as any)
vi.mock('../../stores.svelte', () => ({
    DBState: { db: state },
    selIdState: { selId: 0 },
    selectedCharID: { set: vi.fn() },
}) as any)
vi.mock('../../globalApi.svelte', () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(''),
}) as any)
vi.mock('../../process/modules', () => ({
    getModuleAssets: () => [],
    getModuleLorebooks: () => [],
    getModules: () => [],
}) as any)
vi.mock('../../process/scripts', () => ({ processScriptFull: () => '' }) as any)
vi.mock('../chatVar.svelte', () => ({
    getChatVar: () => '', setChatVar: () => {}, getGlobalChatVar: () => '',
}) as any)
vi.mock('../../process/infunctions', () => ({ calcString: () => '' }) as any)
vi.mock('../../util', () => ({
    findCharacterbyId: () => undefined, getPersonaPrompt: () => '', getUserIcon: () => '',
    getUserName: () => '', pickHashRand: () => 0, replaceAsync: async (s: string) => s,
}) as any)
vi.mock('../../process/files/inlays', () => ({ getInlayInfosBatch: () => [] }) as any)
vi.mock('../../model/modellist', () => ({ getModelInfo: () => undefined }) as any)
vi.mock('../../cbs', () => ({ registerCBS: () => {} }) as any)
vi.mock('src/lang', () => ({ language: {} }))

import { trimMarkdown } from '../parser.svelte'

const encodedStyle = (css: string) => `<risu-style>${Buffer.from(css).toString('hex')}</risu-style>`

describe('trimMarkdown Risu style decoding', () => {
    test('preserves SVG data URI CSS without reparsing it as markup', () => {
        const css = '.logo{background:url("data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'><path d=\'M0 0h1v1H0z\'/></svg>")}'

        const output = trimMarkdown(encodedStyle(css))

        expect(output).toContain('data:image/svg+xml,<svg xmlns=')
        expect(output).toContain('<path d=')
    })

    test('preserves markup-like CSS content as CSS text', () => {
        const css = '.badge::before{content:"<em>literal markup</em>"}'

        const output = trimMarkdown(encodedStyle(css))

        expect(output).toContain('content:"<em>literal markup</em>"')
    })

    test('does not allow decoded CSS to terminate the style element and inject markup', () => {
        const css = '.badge::before{content:"</style><img src=x onerror=alert(1)>"}'

        const output = trimMarkdown(encodedStyle(css))
        const container = document.createElement('div')
        container.innerHTML = output

        expect(container.querySelector('img')).toBeNull()
        expect(output).toContain('<\\/style>')
    })

    test('keeps CSS parse diagnostics outside the style element', () => {
        state.returnCSSError = true

        const output = trimMarkdown(encodedStyle('.broken{'))

        expect(output).toMatch(/^CSS ERROR:/)
        expect(output).not.toContain('<style>')
        state.returnCSSError = false
    })

    test('does not reuse a cached CSS error result when returnCSSError changes', () => {
        const input = encodedStyle('.cache-broken{')
        state.returnCSSError = false
        expect(trimMarkdown(input)).not.toMatch(/^CSS ERROR:/)

        state.returnCSSError = true
        expect(trimMarkdown(input)).toMatch(/^CSS ERROR:/)
        state.returnCSSError = false
    })
})
