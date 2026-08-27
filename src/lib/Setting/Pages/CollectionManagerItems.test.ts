import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const modules = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/Module/ModuleSettings.svelte'), 'utf8')
const plugins = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/PluginSettings.svelte'), 'utf8')

function styleRule(source: string, selector: string) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ''
}

describe('collection manager item layout', () => {
    test('opts only the module list into the resizable settings page', () => {
        expect(modules).toMatch(/\{#if mode === 0\}\s*<SettingPage resizable title=\{language\.modules\}>/)
        expect(modules.match(/<SettingPage resizable\b/g)).toHaveLength(1)
        expect(modules).toContain('<SettingPage title={language.createModule}>')
        expect(modules).toContain('<SettingPage title={language.editModule}>')
    })

    test('opts the plugin list into the resizable settings page', () => {
        expect(plugins).toContain('<SettingPage resizable title={language.plugin}>')
    })

    test.each([
        ['module', modules],
        ['plugin', plugins],
    ])('lets the %s header and actions wrap within their available pane', (kind, source) => {
        for (const part of ['header', 'actions']) {
            const className = `${kind}-item-${part}`
            expect(source).toMatch(new RegExp(`class="${className}(?: |")`))
            const rule = styleRule(source, `.${className}`)
            expect(rule).toMatch(/display:\s*flex/)
            expect(rule).toMatch(/flex-wrap:\s*wrap/)
            expect(rule).toMatch(/min-width:\s*0/)
        }
        expect(styleRule(source, `.${kind}-item-actions`)).toMatch(/max-width:\s*100%/)
    })

    test.each([
        ['module', modules],
        ['plugin', plugins],
    ])('wraps long unbroken %s names without displacing actions', (kind, source) => {
        const className = `${kind}-item-title`
        expect(source).toMatch(new RegExp(`class="${className}(?: |")`))
        const rule = styleRule(source, `.${className}`)
        expect(rule).toMatch(/min-width:\s*0/)
        expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
    })

    test('keeps long module descriptions within the item width', () => {
        expect(modules).toContain('class="module-item-description ')
        expect(styleRule(modules, '.module-item-description')).toMatch(/overflow-wrap:\s*anywhere/)
    })

    test('allows plugin argument labels and divider text to wrap', () => {
        const argumentsRule = styleRule(plugins, '.plugin-arguments')
        expect(argumentsRule).toMatch(/min-width:\s*0/)
        expect(argumentsRule).toMatch(/overflow-wrap:\s*anywhere/)
        expect(plugins).toContain('class="plugin-argument-divider ')
        expect(styleRule(plugins, '.plugin-argument-divider')).toMatch(/min-width:\s*0/)
        expect(plugins).not.toContain('text-nowrap')
    })

    test('constrains every plugin argument control to the pane width', () => {
        for (const component of ['SelectInput', 'TextAreaInput', 'TextInput', 'NumberInput', 'CheckInput']) {
            const controls = [...plugins.matchAll(new RegExp(`<${component}\\s+([^]*?)(?:\\/>|>)`, 'g'))]
            expect(controls.length).toBeGreaterThan(0)
            for (const [, attributes] of controls) {
                expect(attributes).toMatch(/className="[^"]*min-w-0[^"]*w-full[^"]*max-w-full/)
            }
        }
    })
})
