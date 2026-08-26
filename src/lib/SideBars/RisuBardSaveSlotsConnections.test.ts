import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const chatScreenSource = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'
), 'utf8')
const shortcutsPath = resolve(
    process.cwd(), 'src/lib/ChatScreens/RisuBardSaveLoadShortcuts.svelte'
)
const shortcutsSource = existsSync(shortcutsPath)
    ? readFileSync(shortcutsPath, 'utf8')
    : ''
const defaultChatSource = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/DefaultChatScreen.svelte'
), 'utf8')
const dialogSource = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/RisuBardSaveSlotsDialog.svelte'
), 'utf8')
const buttonSource = readFileSync(resolve(
    process.cwd(), 'src/lib/UI/GUI/ShButton.svelte'
), 'utf8')
const stylesSource = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
const commonSettingsSource = readFileSync(resolve(
    process.cwd(), 'src/ts/setting/risuBardCommonSettingsData.ts'
), 'utf8')
const databaseSource = readFileSync(resolve(
    process.cwd(), 'src/ts/storage/database.svelte.ts'
), 'utf8')
const koreanSource = readFileSync(resolve(process.cwd(), 'src/lang/ko.ts'), 'utf8')

describe('chat file save slot connections', () => {
    test('opens save mode in every chat theme and only writes after choosing a slot', () => {
        expect(chatScreenSource.match(/onSaveChat=\{\(\) => openSaveSlots\('save'\)\}/g))
            .toHaveLength(3)
        expect(chatScreenSource.match(/onOpenChatLoad=\{\(\) => openSaveSlots\('load'\)\}/g))
            .toHaveLength(3)
        expect(chatScreenSource).toContain('bind:mode={saveSlotsMode}')
        expect(chatScreenSource).toContain('onSave={saveCurrentChat}')
        expect(chatScreenSource).toContain('saveId: saveId ?? v4()')
        expect(chatScreenSource).toContain('overwrite: saveId !== undefined')
    })

    test('removes save and load actions from the character sidebar', () => {
        expect(source).toContain('data-chat-file-header')
        expect(source).not.toContain('data-chat-file-toolbar')
        expect(source).not.toContain('data-risubard-save-chat')
        expect(source).not.toContain('data-risubard-load-chat')
        expect(source).not.toContain('<RisuBardSaveSlotsDialog')
    })

    test('adds shared save and load entries to the composer menu and floating dock', () => {
        expect(defaultChatSource).toContain('data-composer-save-chat')
        expect(defaultChatSource).toContain('data-composer-load-chat')
        expect(defaultChatSource).toContain('onSaveChat')
        expect(defaultChatSource).toContain('onOpenChatLoad')
        expect(defaultChatSource).toMatch(
            /<main[^>]*data-chat-pane[\s\S]*<RisuBardSaveLoadShortcuts/
        )
        expect(defaultChatSource).toContain('data-save-load-shortcut-anchor')
        expect(defaultChatSource).toContain('anchorElement={saveLoadShortcutAnchor}')
        expect(chatScreenSource).not.toContain('<RisuBardSaveLoadShortcuts')
        expect(shortcutsSource).toContain('data-chat-file-shortcuts')
        expect(shortcutsSource).toContain('data-shortcut-save-chat')
        expect(shortcutsSource).toContain('data-shortcut-load-chat')
        expect(shortcutsSource).toContain('>save</span>')
        expect(shortcutsSource).toContain('>load</span>')
        expect(shortcutsSource).toContain('role="group"')
        expect(shortcutsSource).toContain('aria-label={language.risuBardShowSaveLoadShortcuts}')
        expect(shortcutsSource).toContain('position: absolute')
        expect(chatScreenSource).toContain('<RisuBardSaveSlotsDialog')
    })

    test('keeps the labeled shortcut block draggable and persistently movable', () => {
        expect(shortcutsSource).toContain('resolveSaveLoadShortcutPosition(')
        expect(shortcutsSource).toContain('anchorSaveLoadShortcut(')
        expect(shortcutsSource).toContain('onpointerdown={beginDrag}')
        expect(shortcutsSource).toContain('onpointermove={moveDrag}')
        expect(shortcutsSource).toContain('onpointerup={endDrag}')
        expect(shortcutsSource).toContain('(event.target as HTMLElement).setPointerCapture')
        expect(shortcutsSource).toContain('risuBardSaveLoadShortcutPlacement')
        expect(shortcutsSource).toContain('requestImmediateSave()')
        expect(shortcutsSource).toContain('touch-action: none')
    })

    test('uses the requested Solar icons inside the floating block', () => {
        expect(shortcutsSource).toContain('<SolarAssetIcon src={feedIcon} name="feed-bold"')
        expect(shortcutsSource).toContain('<SolarAssetIcon src={loadIcon} name="undo-left-square-bold"')
        for (const asset of [
            'src/assets/solar-bold/feed-bold.svg',
            'src/assets/solar-bold/undo-left-square-bold.svg',
        ]) {
            expect(existsSync(resolve(process.cwd(), asset))).toBe(true)
        }
    })

    test('can hide and restore the shortcut block from RisuBard common settings', () => {
        expect(shortcutsSource).toContain('alertConfirm(language.risuBardSaveLoadShortcutHideConfirm)')
        expect(shortcutsSource).toContain('DBState.db.showRisuBardSaveLoadShortcuts = false')
        expect(koreanSource).toContain('세이브/로드 버튼을 끌까요? Bardwiki / 공통 옵션에서 다시 켤 수 있습니다')
        expect(commonSettingsSource).toContain("id: 'risubard.common.showSaveLoadShortcuts'")
        expect(commonSettingsSource).toContain("type: 'check'")
        expect(commonSettingsSource).toContain("bindKey: 'showRisuBardSaveLoadShortcuts'")
        expect(databaseSource).toContain('showRisuBardSaveLoadShortcuts?: boolean')
        expect(databaseSource).toContain('data.showRisuBardSaveLoadShortcuts ??= true')
        expect(defaultChatSource).toContain('DBState.db.showRisuBardSaveLoadShortcuts')
    })

    test('shows the current chat as a plain title above a separate chat-list disclosure', () => {
        const currentStart = source.indexOf('data-current-chat-section')
        const disclosureStart = source.indexOf('data-chat-list-disclosure')
        const currentSection = source.slice(currentStart, disclosureStart)

        expect(currentSection).toContain('data-current-chat-label')
        expect(currentSection).toContain('language.currentChatLabel')
        expect(currentSection).toContain('data-current-chat-title')
        expect(currentSection).not.toContain('data-chat-list-toggle')
        expect(currentSection).not.toContain('ChevronRightIcon')
        expect(source).toContain('data-chat-list-disclosure')
        expect(source).toContain('bind:open={chatListExpanded}')
        expect(source).toContain('name={language.sidebarChatListLabel}')
    })

    test('places the chat management toolbar and clean chat rows inside the disclosure', () => {
        const disclosureStart = source.indexOf('data-chat-list-disclosure')
        const settingsStart = source.indexOf('class="border-t border-selected mt-2"')
        const disclosure = source.slice(disclosureStart, settingsStart)

        expect(disclosure).toContain('data-chat-list-toolbar')
        expect(disclosure).toContain('data-sidebar-new-chat')
        expect(disclosure).toContain('data-chat-list-row')
        expect(disclosure).not.toContain('data-chat-row-actions')
        expect(source).toContain('data-chat-list-toolbar')
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
        expect(dialogSource).toContain('<SolarAssetIcon src={loadIcon} name="undo-left-square-bold"')
        expect(dialogSource).toContain('@media (max-width: 767px)')
        expect(dialogSource).toContain('height: 70vh')
        expect(dialogSource).not.toContain('SAVE_SLOT_DIALOG_GEOMETRY_KEY')
        expect(dialogSource).not.toContain('bind:contentElement')
        expect(dialogSource).not.toContain('class="save-dialog__drag-handle"')
        expect(dialogSource).toContain('data-preview-resize-handle')
        expect(dialogSource).toContain('role="separator"')
        expect(dialogSource).toContain('overflow-y: scroll')
        expect(dialogSource).toContain('scrollbar-gutter: stable')
        expect(dialogSource).toContain('size={48}')
        expect(dialogSource).toContain('[턴 {slot.turnCount}]')
        expect(dialogSource).toContain("'{selectedSlot.sourceChatName}'의 최근 대화")
        expect(dialogSource).toContain('currentChatId: string')
        expect(dialogSource).toContain('sourceChatId: currentChatId')
        expect(chatScreenSource).toContain(
            'currentChatId={currentCharacter.chats[currentCharacter.chatPage]?.id}'
        )
    })

    test('replaces the current chat and finalizes its wiki only after persistence', () => {
        expect(chatScreenSource).toContain('const destinationChatId = currentChat.id')
        expect(chatScreenSource).toMatch(/prepareMemorySaveLoad\(\{[^}]*currentChat,/)
        expect(chatScreenSource).toContain('destinationChatId,')
        expect(chatScreenSource).toContain('loadedChat.id = destinationChatId')
        expect(chatScreenSource).toContain('character.chats[chatIdx] = loadedChat')
        expect(chatScreenSource).toContain('character.chats[chatIdx] = currentChat')
        expect(chatScreenSource).toContain('changeChatTo(chatIdx)')
        expect(chatScreenSource).not.toContain('character.chats.unshift(loadedChat)')
        expect(chatScreenSource).toMatch(
            /prepareMemorySaveLoad[\s\S]*requestImmediateSave[\s\S]*action: 'finalize'/
        )
        expect(chatScreenSource).toMatch(
            /catch\(error\)[\s\S]*action: 'discard'/
        )
        expect(chatScreenSource).not.toContain('void requestImmediateSave({ forceFullWrite: true })')
        expect(chatScreenSource).toContain("notifySuccess('스토리 불러오기 완료', { duration: 3000 })")
    })

    test('uses the defined theme tokens for opaque save slot surfaces', () => {
        expect(dialogSource).toContain('var(--color-darkbg)')
        expect(dialogSource).not.toMatch(
            /var\(--(?:darkbg|darkborderc|borderc|selected|textcolor|textcolor2)\)/
        )
    })
})
