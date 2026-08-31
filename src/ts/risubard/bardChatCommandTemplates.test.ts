import { describe, expect, test } from 'vitest'
import { BARDCHAT_COMMAND_TEMPLATES } from './bardChatCommandTemplates'

describe('BARDCHAT command templates', () => {
    test('provides the core administrator command set with unique IDs', () => {
        const ids = BARDCHAT_COMMAND_TEMPLATES.map((template) => template.id)

        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toEqual(expect.arrayContaining([
            'combine', 'expand', 'shorten', 'summarize',
            'reconnect', 'networking',
        ]))
    })

    test('makes combine preserve one survivor and clean up only after relinking', () => {
        const combine = BARDCHAT_COMMAND_TEMPLATES.find(
            (template) => template.id === 'combine'
        )

        expect(combine?.prompt).toContain('작업: COMBINE')
        expect(combine?.prompt).toContain('하나를 존속 문서로 선택')
        expect(combine?.prompt).toContain('사실과 출처를 보존')
        expect(combine?.prompt).toContain('위키 링크를 존속 문서로 재연결')
        expect(combine?.prompt).toContain('마지막에 휴지통')
    })
})
