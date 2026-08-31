import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = () => readFileSync(resolve('src/lib/ChatScreens/ArcaChatLogDialog.svelte'), 'utf8')
const chatScreen = () => readFileSync(resolve('src/lib/ChatScreens/DefaultChatScreen.svelte'), 'utf8')

describe('ArcaChatLogDialog shell', () => {
    test('uses the canonical dialog with whole-chat, page, turn, and user-message controls', () => {
        const component = source()

        expect(component).toContain("import ShDialog from '../UI/GUI/ShDialog.svelte'")
        expect(component).toContain('<ShDialog')
        expect(component).toContain('data-arca-log-mode="all"')
        expect(component).toContain('data-arca-log-mode="page"')
        expect(component).toContain('data-arca-log-mode="turn"')
        expect(component).not.toContain('data-arca-log-mode="range"')
        expect(component).toContain('data-arca-log-user-messages')
        expect(component).toContain('risuBardArcaChatIncludeUserMessages')
        expect(component).toContain('data-arca-log-preview')
    })

    test('places range inputs beside the user toggle and shows character and image totals', () => {
        const component = source()

        expect(component).toContain('class="arca-log-range-row"')
        expect(component).toContain('data-arca-log-range-start')
        expect(component).toContain('data-arca-log-range-end')
        expect(component).toContain('summarizeArcaLogMessages')
        expect(component).toContain('selectionSummary.characters')
        expect(component).toContain('selectionSummary.images')
        expect(component).toContain('getChatPageCount')
        expect(component).toContain('getArcaLogTurnCount')
    })

    test('exposes accessible resize handles and the export settings beside the preview', () => {
        const component = source()

        expect(component).toContain("import ManagerResizeHandles from '../UI/GUI/ManagerResizeHandles.svelte'")
        expect(component).toContain('bind:contentElement')
        expect(component).toContain('onResizeEnd={persistDialogSize}')
        expect(component).toContain('risuBardArcaChatDialogSize')
        expect(component).toContain('data-arca-log-setting="font-size"')
        expect(component).toContain('data-arca-log-setting="paragraph-spacing"')
        expect(component).toContain('data-arca-log-setting="image-width"')
        expect(component).toContain('data-arca-log-setting="profile-images"')
        expect(component).toContain('DBState.db.risuBardArcaChatFontSizePx')
        expect(component).toContain('DBState.db.risuBardArcaChatParagraphSpacingPercent')
        expect(component).toContain('DBState.db.risuBardArcaChatImageWidthPercent')
        expect(component).toContain('DBState.db.risuBardArcaChatShowTitleImage')
        expect(component).toContain('data-arca-log-settings-apply')
        expect(component).toContain('data-arca-log-settings-cancel')
        expect(component).toContain('applyAppearanceSettings')
        expect(component).toContain('cancelAppearanceSettings')
    })

    test('uses a compact collapsible sidebar and one-line enlarged section titles', () => {
        const component = source()

        expect(component).toContain('data-arca-log-sidebar-toggle')
        expect(component).toContain('class:sidebar-collapsed={!sidebarOpen}')
        expect(component).not.toContain('language.arcaChatLog.stepOne')
        expect(component).not.toContain('language.arcaChatLog.stepTwo')
        expect(component).toContain('font-size: 1.25rem')
        expect(component).toContain('white-space: nowrap')
    })

    test('closes on outside clicks and waits for visible rendered message content', () => {
        const component = source()

        expect(component).toContain('closeOnOutsideClick={true}')
        expect(component).toContain('hasVisibleArcaLogContent(body)')
    })

    test('stages the real chat renderer and copies rich and plain clipboard formats', () => {
        const component = source()

        expect(component).toContain('mount(Chat')
        expect(component).toContain('const requestedKey = selectionKey')
        expect(component).toContain('preparedKey = requestedKey')
        expect(component).toContain('new ClipboardItem')
        expect(component).toContain("'text/html'")
        expect(component).toContain("'text/plain'")
        expect(component).toContain('renderComplexBlock: renderComplexArcaBlock')
        expect(component).toContain('planArcaComplexSnapshots')
        expect(component).toContain('target.excludeElements')
    })

    test('keeps a responsive single-column mobile layout', () => {
        const component = source()

        expect(component).toMatch(/@media\s*\(max-width:\s*640px\)/)
        expect(component).toContain('grid-template-columns: minmax(0, 1fr)')
    })

    test('is opened from the existing chat menu with the full current chat', () => {
        const screen = chatScreen()

        expect(screen).toContain("import ArcaChatLogDialog from './ArcaChatLogDialog.svelte'")
        expect(screen).toContain('data-open-arca-chat-log')
        expect(screen).toContain('<ArcaChatLogDialog')
        expect(screen).toContain('chat={currentChatSlot}')
    })

    /**
     * The dialog logs and exports `chat.message` in full, so opening it on a
     * windowed chat would present one page of the conversation as the whole
     * chat -- and the page count is derived from the same sliced array, so the
     * dialog itself would not show that anything was missing. `currentChatReady`
     * does not cover this: it means "hydrated", not "whole".
     */
    test('loads the whole history before opening, and refuses rather than logging a slice', () => {
        const screen = chatScreen()

        expect(screen).toContain('onSelect={() => { void openArcaChatLog() }}')
        expect(screen).toContain('async function openArcaChatLog()')
        expect(screen).toContain('chatNeedsServerFetch(chat)')
        expect(screen).toContain('hasOlderSqlMessages(chat)')
        expect(screen).toContain('await fetchChatFromServer(char.chaId, char.chatPage, chat.id)')
        // The refusal must come before the dialog opens, not after.
        const guard = screen.indexOf('async function openArcaChatLog()')
        expect(guard).toBeGreaterThan(-1)
        const body = screen.slice(guard, guard + 1800)
        expect(body.indexOf('return')).toBeLessThan(body.indexOf('arcaChatLogOpen = true'))
        // Assigned whole. Merging the slice's runtime window onto the fetched
        // history would re-mark it partial, undoing the fetch.
        expect(body).toContain('char.chats[char.chatPage] = full as ChatData')
        expect(body).not.toContain('carrySqlRuntimeFields(')
    })
})
