import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/Chat.svelte'
), 'utf8')
const korean = readFileSync(resolve(process.cwd(), 'src/lang/ko.ts'), 'utf8')
const english = readFileSync(resolve(process.cwd(), 'src/lang/en.ts'), 'utf8')

describe('confirmed message deletion', () => {
    test('allows confirmed deletion and retracts events for every removed ID first', () => {
        expect(source).toContain('retractWikiEventsBySourceMessages')
        expect(source).not.toContain('deletionTouchesBardWikiEvidence')
        expect(source).not.toContain('message?.risubardMemoryConfirmed === true')
        expect(source).toContain("language.removeMessageOnly.includes('{}')")
        expect(source).toContain('`${language.removeMessageOnly} (1)`')
        expect(source).toContain("typeof message?.chatId === 'string'")
        expect(source.indexOf('await retractWikiEventsBySourceMessages'))
            .toBeLessThan(source.indexOf('msg.splice(idx, 1)'))
    })

    test('warns that only linked events are removed and canonical state needs reboot', () => {
        expect(source).toContain(
            'alertConfirmMulti(language.bardWikiDeleteWarning, actions)'
        )
        expect(korean).toContain('연결된 사건 요약은 함께 삭제됩니다')
        expect(korean).toContain('기타 정본은 과거 상태로 자동 복원되지 않습니다')
        expect(korean).toContain('위키 리부트')
        expect(english).toContain('Linked event summaries are deleted together')
        expect(english).toContain('Other canonical documents are not rolled back')
        expect(english).toContain('Wiki Reboot')
    })

    test('refreshes an open Memory Wiki after linked events are removed', () => {
        expect(source).toContain('announceRisuBardMemoryUpdated')
        expect(source.indexOf('announceRisuBardMemoryUpdated({'))
            .toBeGreaterThan(source.indexOf('await retractWikiEventsBySourceMessages'))
        expect(source.indexOf('announceRisuBardMemoryUpdated({'))
            .toBeLessThan(source.indexOf('msg.splice(idx, 1)'))
    })
})

describe('confirmed message editing', () => {
    test('keeps the edit control available after BardWiki confirmation', () => {
        const editStart = source.indexOf('{#snippet translationButton')
        const editEnd = source.indexOf('{#snippet rerolls', editStart)
        const editControls = source.slice(editStart, editEnd)

        expect(editControls).toContain('button-icon-edit')
        expect(editControls).not.toContain('!memoryConfirmed')
        expect(editControls).toContain('&& !memoryConfirming')
    })
})
