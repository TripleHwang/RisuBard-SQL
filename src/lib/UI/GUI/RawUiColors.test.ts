import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

const projectRoot = process.cwd()
const extensions = new Set(['.css', '.js', '.svelte', '.ts'])

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return sourceFiles(path)
        if (!extensions.has(extname(path)) || /\.(?:test|spec)\.[^.]+$/.test(path)) return []
        return [path]
    })
}

// These are authored/exported colors, not application chrome. Keep exceptions
// tied to a literal AND its source expression so new UI colors cannot hide here.
const authoredColors = [
    {
        file: 'src/lib/UI/GUI/ColorInput.svelte',
        expression: "value = $bindable('#000000')",
        colors: ['#000000'],
        reason: 'The selected color is a user-editable color value, not picker chrome.',
    },
    {
        file: 'src/lib/SideBars/CharacterVaultDialog.svelte',
        expression: "value={activeFolder.color.startsWith('#') ? activeFolder.color : '#8b6a34'}",
        colors: ['#8b6a34'],
        reason: 'An explicit folder-color input default is stored as user data.',
    },
    {
        file: 'src/lib/SideBars/CharacterVaultDialog.svelte',
        expression: '.color-red { background:#b91c1c }',
        colors: ['#b91c1c', '#a16207', '#15803d', '#1d4ed8', '#4338ca', '#7e22ce', '#be185d', '#64748b'],
        reason: 'These swatches represent the named folder colors the user selects.',
    },
    {
        file: 'src/ts/firstMessageStudio.ts',
        expression: "preset: 'minimal', accentColor:",
        colors: ['#5b8cff', '#111827', '#1f2937', '#f8fafc'],
        reason: 'Portable first-message content has its own authored appearance preset.',
    },
    {
        file: 'src/ts/firstMessageStudio.ts',
        expression: "preset: 'glass', accentColor:",
        colors: ['#65d9ff', '#111827', '#142c3c', '#f0fbff'],
        reason: 'Portable first-message content has its own authored appearance preset.',
    },
    {
        file: 'src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte',
        expression: 'data-studio-custom-css',
        colors: ['#7dd3fc'],
        reason: 'This is example CSS shown in a placeholder, not applied editor styling.',
    },
    {
        file: 'src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte',
        expression: '.skin-swatch.minimal{background:',
        colors: ['#1f2937', '#5b8cff', '#111827', '#65d9ff88', '#1b4661cc', '#101827', '#ff6b6b', '#ffd166', '#65d9ff', '#b18cff'],
        reason: 'Swatches preview the authored content skins rather than the application theme.',
    },
    {
        file: 'src/ts/firstMessageStudioSharing.ts',
        expression: 'return `<style>[data-first-message-studio-compatible]',
        colors: ['rgba(0,0,0,.28)'],
        reason: 'The authored portable card shadow must remain self-contained outside the app.',
    },
    {
        file: 'src/lib/ChatScreens/Chat.svelte',
        expression: "themeColor('--risu-theme-",
        colors: ['#292d3e', '#202331', '#f7f8fc', '#aeb6cc', '#454b61'],
        reason: 'These fallbacks style exported Arca clipboard HTML, not application chrome.',
    },
    {
        file: 'src/lib/ChatScreens/ArcaChatLogDialog.svelte',
        expression: "color('--risu-theme-",
        colors: ['#292d3e', '#202331', '#f7f8fc', '#aeb6cc', '#454b61'],
        reason: 'These fallbacks style exported Arca chat-log HTML, not application chrome.',
    },
    ...['src/ts/persona.ts', 'src/ts/characterPackage.ts'].map((file) => ({
        file,
        expression: "ctx.fillStyle = 'rgb(100, 116, 139)'",
        colors: ['rgb(100, 116, 139)'],
        reason: 'A fallback portrait is rasterized into exported PNG data, not rendered UI.',
    })),
] as const

// Raw CSS/inline color syntax only: fixed Tailwind utility palettes have their
// own contract. Variable-based rgba() remains valid and is not a raw color.
const rawLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.][^)]*\)|(?<=(?:color|background|fill|stroke)\s*:\s*|(?:fill|stroke)\s*=\s*['"]|solid\s|,\s*)(white|black|red|green|blue|yellow|orange|gray|grey|pink|purple|cyan|magenta)(?=[\s;,)'"}]|$)/gi

function uncomment(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
        .split(/\r?\n/)
        .map((line) => /^\s*\/\//.test(line) ? '' : line)
        .join('\n')
}

const uiSources = [
    ...sourceFiles(join(projectRoot, 'src/lib')),
    ...[
        'characters.ts', 'characterPackage.ts', 'persona.ts',
        'firstMessageStudio.ts', 'firstMessageStudioSharing.ts',
        'parser/parser.svelte.ts', 'setting/searchIndex.ts',
    ].map((file) => join(projectRoot, 'src/ts', file)),
]

describe('application-owned raw UI colors', () => {
    test('uses theme tokens except for specifically documented authored colors', () => {
        const violations: string[] = []
        const usedExceptions = new Set<string>()
        for (const path of uiSources) {
            const file = relative(projectRoot, path).replaceAll('\\', '/')
            const lines = uncomment(readFileSync(path, 'utf8')).split('\n')
            lines.forEach((line, index) => {
                for (const match of line.matchAll(rawLiteral)) {
                    const exception = authoredColors.find((item) => item.file === file
                        && line.includes(item.expression)
                        && (item.colors as readonly string[]).includes(match[0]))
                    if (exception) {
                        usedExceptions.add(`${exception.file}:${exception.expression}:${match[0]}`)
                    } else {
                        violations.push(`${file}:${index + 1} ${match[0]}`)
                    }
                }
            })
        }
        expect(violations, 'UI CSS must use --color-* tokens; authored-color exceptions need a specific expression and reason.').toEqual([])
        for (const exception of authoredColors) {
            expect(exception.reason).not.toBe('')
            for (const color of exception.colors) {
                expect(usedExceptions.has(`${exception.file}:${exception.expression}:${color}`),
                    `Remove stale authored-color exception: ${exception.file} ${color}`).toBe(true)
            }
        }
    })

    test('does not rely on the undeclared selected RGB alias', () => {
        const source = readFileSync(join(projectRoot, 'src/lib/SideBars/LoreBook/LoreBookData.svelte'), 'utf8')
        expect(source.includes('--risu-theme-selected-rgb')).toBe(false)
    })
})
