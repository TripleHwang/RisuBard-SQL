import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const dialogSource = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/RisuBardSaveSlotsDialog.svelte'
), 'utf8')
const buttonSource = readFileSync(resolve(
    process.cwd(), 'src/lib/UI/GUI/ShButton.svelte'
), 'utf8')
const stylesSource = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

describe('character sidebar save slot connections', () => {
    test('groups save and load with the selected chat file controls', () => {
        expect(source).toContain('data-chat-file-header')
        expect(source).toContain('data-chat-file-toolbar')
        expect(source).toContain('data-risubard-save-chat')
        expect(source).toContain('data-risubard-load-chat')
        expect(source).toContain('<RisuBardSaveSlotsDialog')
        expect(source).toContain('<SolarAssetIcon src={feedIcon} name="feed-bold"')
        expect(source).toContain('<SolarAssetIcon src={loadIcon} name="undo-left-square-bold"')
        for (const asset of [
            'src/assets/solar-bold/feed-bold.svg',
            'src/assets/solar-bold/undo-left-square-bold.svg',
        ]) {
            expect(existsSync(resolve(process.cwd(), asset))).toBe(true)
        }
        expect(source).not.toContain('슬롯 저장')
        expect(source).not.toContain('슬롯 불러오기')
    })

    test('matches the model settings button size and separates the soft-blue file actions', () => {
        const toolbarStart = source.indexOf('data-chat-file-toolbar')
        const toolbarEnd = source.indexOf('</div>', toolbarStart)
        const toolbar = source.slice(toolbarStart, toolbarEnd)
        expect(toolbar).toContain('gap-2')
        expect(toolbar.match(/size="icon"/g)).toHaveLength(2)
        expect(toolbar.match(/variant="soft-primary"/g)).toHaveLength(2)
        expect(toolbar).toContain('>SAVE</span>')
        expect(toolbar).toContain('>LOAD</span>')
        expect(toolbar.match(/text-\[8px\]/g)).toHaveLength(2)
        expect(toolbar.match(/size=\{22\}/g)).toHaveLength(2)
        expect(buttonSource).toContain("'soft-primary'")
    })

    test('reveals the list toolbar and clean chat rows from the chat file heading', () => {
        expect(source).toContain('data-chat-list-toggle')
        expect(source).toContain('aria-expanded={chatListExpanded}')
        expect(source).toContain('data-chat-list-toolbar')
        expect(source).toContain('data-sidebar-new-chat')
        expect(source).toContain('data-chat-list-row')
        expect(source).not.toContain('data-chat-row-actions')
        expect(source).toMatch(
            /data-chat-list-toolbar[\s\S]*deleteCurrentChat[\s\S]*TrashIcon/
        )
    })

    test('standardizes the one-pixel hover lift for shared buttons', () => {
        expect(buttonSource).toContain('risu-button-lift')
        expect(stylesSource).toContain('.risu-button-lift:hover:not(:disabled)')
        expect(stylesSource).toContain('transform: translateY(-1px)')
    })

    test('turns the load dialog into a selectable file workspace', () => {
        expect(dialogSource).not.toContain('{#snippet description()}')
        expect(dialogSource).toContain('저장된 파일')
        expect(dialogSource).toContain('data-save-file-toolbar')
        expect(dialogSource).not.toContain('save-ledger__refresh')
        expect(dialogSource).toContain('data-save-file-rename')
        expect(dialogSource).toContain('data-save-file-delete')
        expect(dialogSource).toContain('data-save-file-sort')
        expect(dialogSource).toContain('data-save-file-grid')
        expect(dialogSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
        expect(dialogSource).toContain('overflow-y: auto')
        expect(dialogSource).toContain('data-save-file-preview')
        expect(dialogSource).toContain('previewMemorySaveSlot')
        expect(dialogSource).toContain('grid-template-columns: minmax(0, 1fr)')
        expect(dialogSource).not.toContain('minmax(0, 1.35fr)')
        expect(dialogSource).toContain('height: min(30vh, 18rem)')
        expect(dialogSource).toContain('<SolarAssetIcon src={loadIcon} name="undo-left-square-bold"')
        expect(dialogSource).toContain('@media (max-width: 767px)')
        expect(dialogSource).toContain('height: 30vh')
    })

    test('finalizes a loaded wiki only after the new chat is persisted', () => {
        expect(source).toMatch(
            /prepareMemorySaveLoad[\s\S]*requestImmediateSave[\s\S]*action: 'finalize'/
        )
        expect(source).toMatch(
            /catch\(error\)[\s\S]*action: 'discard'/
        )
    })

    test('uses the defined theme tokens for opaque save slot surfaces', () => {
        expect(dialogSource).toContain('var(--color-darkbg)')
        expect(dialogSource).not.toMatch(
            /var\(--(?:darkbg|darkborderc|borderc|selected|textcolor|textcolor2)\)/
        )
    })
})
