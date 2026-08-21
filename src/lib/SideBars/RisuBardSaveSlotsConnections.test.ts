import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const chatScreenSource = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'
), 'utf8')
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

describe('chat file save slot connections', () => {
    test('removes save and load actions from the character sidebar', () => {
        expect(source).toContain('data-chat-file-header')
        expect(source).not.toContain('data-chat-file-toolbar')
        expect(source).not.toContain('data-risubard-save-chat')
        expect(source).not.toContain('data-risubard-load-chat')
        expect(source).not.toContain('<RisuBardSaveSlotsDialog')
    })

    test('adds shared save and load entries to the composer menu and chat edge', () => {
        expect(defaultChatSource).toContain('data-composer-save-chat')
        expect(defaultChatSource).toContain('data-composer-load-chat')
        expect(defaultChatSource).toContain('onSaveChat')
        expect(defaultChatSource).toContain('onOpenChatLoad')
        expect(chatScreenSource).toContain('data-chat-file-edge-actions')
        expect(chatScreenSource).toContain('data-edge-save-chat')
        expect(chatScreenSource).toContain('data-edge-load-chat')
        expect(chatScreenSource).toContain('class="absolute bottom-20 left-0')
        expect(chatScreenSource).toContain('flex-col')
        expect(chatScreenSource).toContain('<RisuBardSaveSlotsDialog')
    })

    test('uses aligned icon-only edge buttons with the requested Solar icons', () => {
        expect(chatScreenSource).toContain('size-12')
        expect(chatScreenSource).toContain('<SolarAssetIcon src={feedIcon} name="feed-bold"')
        expect(chatScreenSource).toContain('<SolarAssetIcon src={loadIcon} name="undo-left-square-bold"')
        expect(chatScreenSource).not.toContain('>SAVE</span>')
        expect(chatScreenSource).not.toContain('>LOAD</span>')
        for (const asset of [
            'src/assets/solar-bold/feed-bold.svg',
            'src/assets/solar-bold/undo-left-square-bold.svg',
        ]) {
            expect(existsSync(resolve(process.cwd(), asset))).toBe(true)
        }
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

    test('loads into a new chat and finalizes its wiki only after persistence', () => {
        expect(chatScreenSource).toContain('const destinationChatId = v4()')
        expect(chatScreenSource).toContain('destinationChatId,')
        expect(chatScreenSource).toContain('loadedChat.id = destinationChatId')
        expect(chatScreenSource).toContain('character.chats.unshift(loadedChat)')
        expect(chatScreenSource).toContain('changeChatTo(0)')
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
