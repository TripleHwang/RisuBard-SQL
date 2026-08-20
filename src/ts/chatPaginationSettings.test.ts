import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('chat page-size setting connections', () => {
    it('normalizes and persists a dedicated bounded page size', () => {
        const database = read('src/ts/storage/database.svelte.ts')
        expect(database).toContain('chatPageSize?: number')
        expect(database).toContain('data.chatPageSize = normalizeChatPageSize(data.chatPageSize)')
    })

    it('exposes page size in accessibility settings with a hard upper bound', () => {
        const settings = read('src/ts/setting/accessibilitySettingsData.ts')
        expect(settings).toContain("id: 'acc.chatPageSize'")
        expect(settings).toContain("bindKey: 'chatPageSize'")
        expect(settings).toContain('max: MAX_CHAT_PAGE_SIZE')
    })

    it('provides Korean and English labels and help', () => {
        expect(read('src/lang/ko.ts')).toContain('chatPageSize: "페이지당 채팅 메시지 수"')
        expect(read('src/lang/en.ts')).toContain('chatPageSize: "Messages Per Chat Page"')
        expect(read('src/lang/help.ko.ts')).toContain('"chatPageSize"')
        expect(read('src/lang/help.en.ts')).toContain('chatPageSize:')
    })
})
