import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('direct RisuBard wiki command connections', () => {
    test('replaces the old workbench with the direct command terminal', () => {
        const dock = read('src/lib/Others/RisuBardMemoryWiki.svelte')
        const editor = read('src/lib/Others/RisuBardWikiEditor.svelte')

        expect(dock).toContain("import RisuBardWikiCommandTerminal")
        expect(dock).toContain('onExecuteWikiCommand?:')
        expect(dock).toContain('<RisuBardWikiCommandTerminal')
        expect(dock).not.toContain('RisuBardMarkdownWorkbench')
        expect(dock).not.toContain('RisuBardWikiBatchDrafts')
        expect(dock).not.toContain('workbenchTargetId')
        expect(editor).not.toContain('onSendToWorkbench')
        expect(editor).not.toContain('작업대로 보내기')
    })

    test('uses the current chat command pipeline and safe mutation APIs', () => {
        const chat = read('src/lib/ChatScreens/DefaultChatScreen.svelte')
        const process = read('src/ts/process/index.svelte.ts')

        expect(chat).toContain('executeCurrentNarrativeWikiCommand')
        expect(chat).toContain(
            'onExecuteWikiCommand={executeCurrentNarrativeWikiCommand}'
        )
        expect(process).toContain(
            'export async function executeCurrentNarrativeWikiCommand'
        )
        expect(process).toContain('executeDirectWikiCommand({')
        expect(process).toContain('saveManualWikiDocument({')
        expect(process).toContain('trashWikiDocument({')
        expect(process).toContain('retractWikiEvent({')
        expect(process).toContain('currentMessages: projected.messages')
        expect(process).toContain('for (const failure of result.failed)')
        expect(process).toContain('미적용 · ${failure.title}: ${failure.reason}')
    })
})
