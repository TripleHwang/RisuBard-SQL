import { describe, expect, test, vi } from 'vitest'
import type { NarrativeMemoryWikiMarkdown } from './memoryWiki'
import {
    executeDirectWikiCommand,
    type DirectWikiModelCall,
} from './directWikiCommand'

type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

const documents: WikiDocument[] = [{
    id: 'character.existing', type: 'character', status: 'active',
    title: '기존 인물', relativePath: 'characters/existing.md',
    sourceMessageIds: ['assistant-old'], updated: 'now',
    content: '# 기존 인물\n\n이전 설정.', links: [], contextMode: 'auto',
    contentHash: 'hash-existing',
}, {
    id: 'concept.crawler', type: 'concept', status: 'active',
    title: '크롤러', relativePath: 'concepts/crawler.md',
    sourceMessageIds: ['assistant-old'], updated: 'now',
    content: '# 크롤러', links: [], contextMode: 'auto',
    contentHash: 'hash-crawler',
}, {
    id: 'event.turn', type: 'event', status: 'active',
    title: '기존 사건', relativePath: 'events/turn.md',
    sourceMessageIds: ['assistant-old'], updated: 'now',
    content: '# 기존 사건', links: [], contextMode: 'auto',
    contentHash: 'hash-event',
}]

describe('direct wiki command', () => {
    test('does not inherit the general chat JSON extraction path', async () => {
        let submitted: DirectWikiModelCall | undefined
        await executeDirectWikiCommand({
            instruction: '새 인물을 만들어.',
            documents,
            currentMessages: [],
            maxTokens: 12_000,
            requestModel: async (request) => {
                submitted = structuredClone(request)
                return {
                    type: 'success',
                    result: JSON.stringify({
                        schemaVersion: 1,
                        operations: [{
                            action: 'upsert', targetDocumentId: null,
                            type: 'character', title: '새 인물',
                            markdown: '# 새 인물\n\n설정.',
                            reason: '사용자 직접 지시',
                        }],
                    }),
                }
            },
            saveDocument: vi.fn(async (input) => ({
                id: 'character.new', title: input.title,
                relativePath: 'characters/new.md',
            })),
            trashDocument: vi.fn(),
            retractEvent: vi.fn(),
        })

        expect(submitted).toMatchObject({ extractJson: '' })
    })

    test('injects only explicitly named wiki targets and omits unrequested chat', async () => {
        let submitted: DirectWikiModelCall | undefined
        await executeDirectWikiCommand({
            instruction: '다른 자료는 아무것도 검색하지 말고, 기존 인물 위키 항목에 비밀 정보를 추가해.',
            documents,
            currentMessages: [{
                messageId: 'assistant-1', role: 'assistant',
                content: '주입되면 안 되는 최신 채팅.',
            }],
            maxTokens: 12_000,
            requestModel: async (request) => {
                submitted = structuredClone(request)
                return {
                    type: 'success',
                    result: JSON.stringify({
                        schemaVersion: 1,
                        operations: [{
                            action: 'upsert',
                            targetDocumentId: 'character.existing',
                            type: 'character', title: '기존 인물',
                            markdown: '# 기존 인물\n\n이전 설정. 비밀 정보.',
                            reason: '사용자 직접 지시',
                        }],
                    }),
                }
            },
            saveDocument: vi.fn(async (input) => ({
                id: input.documentId!, title: input.title,
                relativePath: 'characters/existing.md',
            })),
            trashDocument: vi.fn(),
            retractEvent: vi.fn(),
        })

        const payload = submitted?.formated[1].content ?? ''
        const schema = JSON.parse(submitted?.schema ?? '{}')
        expect(schema.properties.schemaVersion).toEqual({ const: 1 })
        expect(payload).toContain('이전 설정.')
        expect(payload).not.toContain('크롤러')
        expect(payload).not.toContain('기존 사건')
        expect(payload).not.toContain('주입되면 안 되는 최신 채팅')
    })

    test('treats the operator instruction as highest content authority', async () => {
        let submitted: DirectWikiModelCall | undefined
        const result = await executeDirectWikiCommand({
            instruction: '채팅에 없는 새 설정도 만들어서 유나를 character로 추가해.',
            documents,
            currentMessages: [{
                messageId: 'assistant-1', role: 'assistant',
                content: '기존 인물만 등장했다.',
            }],
            maxTokens: 12_000,
            requestModel: async (request) => {
                submitted = structuredClone(request)
                return {
                    type: 'success',
                    result: JSON.stringify({
                        schemaVersion: 1,
                        operations: [{
                            action: 'upsert', targetDocumentId: null,
                            type: 'character', title: '유나',
                            markdown: '# 유나\n\n사용자가 직접 지정한 새 설정.',
                            reason: '사용자 직접 지시',
                        }],
                    }),
                }
            },
            saveDocument: vi.fn(async (input) => ({
                id: 'character.yuna', title: input.title,
                relativePath: 'characters/yuna.md',
            })),
            trashDocument: vi.fn(),
            retractEvent: vi.fn(),
        })

        expect(submitted?.formated[0].content).toContain(
            'highest authority for wiki content'
        )
        expect(submitted?.formated[0].content).toContain(
            'not required to be supported by the chat'
        )
        expect(submitted?.formated[1].content).toContain('채팅에 없는 새 설정도')
        expect(result).toMatchObject({
            applied: [{ action: 'upsert', title: '유나' }],
            failed: [],
        })
    })

    test('applies rename, type change, trash, and event retraction without silently stopping', async () => {
        const saveDocument = vi.fn(async (input) => ({
            id: input.documentId ?? 'character.new',
            title: input.title,
            relativePath: `characters/${input.title}.md`,
        }))
        const trashDocument = vi.fn(async () => undefined)
        const retractEvent = vi.fn(async () => undefined)

        const result = await executeDirectWikiCommand({
            instruction: '모두 실행해.', documents, currentMessages: [],
            maxTokens: 12_000,
            requestModel: async () => ({
                type: 'success',
                result: JSON.stringify({
                    schemaVersion: 1,
                    operations: [{
                        action: 'upsert',
                        targetDocumentId: 'concept.crawler',
                        type: 'character', title: '크롤러 개체',
                        markdown: '# 크롤러 개체\n\n인물로 재분류.',
                        reason: '유형 변경',
                    }, {
                        action: 'trash',
                        targetDocumentId: 'character.existing',
                        type: null, title: null, markdown: null,
                        reason: '병합 후 제거',
                    }, {
                        action: 'retract-event',
                        targetDocumentId: 'event.turn',
                        type: null, title: null, markdown: null,
                        reason: '사건 교정',
                    }],
                }),
            }),
            saveDocument,
            trashDocument,
            retractEvent,
        })

        expect(saveDocument).toHaveBeenCalledWith(expect.objectContaining({
            documentId: 'concept.crawler',
            expectedContentHash: 'hash-crawler',
            type: 'character', title: '크롤러 개체',
        }))
        expect(trashDocument).toHaveBeenCalledWith('character.existing')
        expect(retractEvent).toHaveBeenCalledWith(
            'event.turn', 'hash-event'
        )
        expect(result.applied).toHaveLength(3)
        expect(result.failed).toEqual([])
    })

    test('continues safe operations and reports every failed target', async () => {
        const result = await executeDirectWikiCommand({
            instruction: '두 문서를 갱신해.', documents, currentMessages: [],
            maxTokens: 12_000,
            requestModel: async () => ({
                type: 'success',
                result: JSON.stringify({
                    schemaVersion: 1,
                    operations: ['기존 인물', '새 인물'].map((title, index) => ({
                        action: 'upsert',
                        targetDocumentId: index === 0
                            ? 'character.existing' : null,
                        type: 'character', title,
                        markdown: `# ${title}\n\n변경.`, reason: '직접 지시',
                    })),
                }),
            }),
            saveDocument: vi.fn(async (input) => {
                if (input.documentId) throw new Error('hash conflict')
                return {
                    id: 'character.new', title: input.title,
                    relativePath: 'characters/new.md',
                }
            }),
            trashDocument: vi.fn(), retractEvent: vi.fn(),
        })

        expect(result.applied).toEqual([expect.objectContaining({
            title: '새 인물',
        })])
        expect(result.failed).toEqual([expect.objectContaining({
            title: '기존 인물', reason: 'hash conflict',
        })])
    })

    test('does not report an empty model plan as a successful command', async () => {
        await expect(executeDirectWikiCommand({
            instruction: '반드시 새 문서를 만들어.', documents, currentMessages: [],
            maxTokens: 12_000,
            requestModel: async () => ({
                type: 'success',
                result: JSON.stringify({ schemaVersion: 1, operations: [] }),
            }),
            saveDocument: vi.fn(),
            trashDocument: vi.fn(),
            retractEvent: vi.fn(),
        })).rejects.toThrow('실행할 위키 변경을 반환하지 않았습니다')
    })

    test('treats an invented target ID for a new title as a create', async () => {
        const saveDocument = vi.fn(async (input) => ({
            id: 'character.eugene-generated',
            title: input.title,
            relativePath: 'characters/eugene.md',
        }))
        const result = await executeDirectWikiCommand({
            instruction: '현 메시지의 이유진을 새 character 문서로 만들어.',
            documents,
            currentMessages: [],
            maxTokens: 12_000,
            requestModel: async () => ({
                type: 'success',
                result: JSON.stringify({
                    schemaVersion: 1,
                    operations: [{
                        action: 'upsert',
                        targetDocumentId: 'character.eugene-lee',
                        type: 'character',
                        title: '이유진',
                        markdown: '# 이유진\n\n새 인물.',
                        reason: '이유진 프로필 생성',
                    }],
                }),
            }),
            saveDocument,
            trashDocument: vi.fn(),
            retractEvent: vi.fn(),
        })

        expect(saveDocument).toHaveBeenCalledWith({
            type: 'character',
            title: '이유진',
            markdown: '# 이유진\n\n새 인물.',
        })
        expect(result.failed).toEqual([])
        expect(result.applied).toEqual([expect.objectContaining({
            title: '이유진',
        })])
    })
})
