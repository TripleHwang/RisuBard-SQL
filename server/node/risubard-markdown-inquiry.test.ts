import { describe, expect, test } from 'vitest'
import type { MarkdownWikiDocument } from './risubard-markdown-wiki'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'

function document(
    input: Partial<MarkdownWikiDocument> & Pick<
        MarkdownWikiDocument,
        'id' | 'type' | 'title' | 'relativePath' | 'content'
    >
): MarkdownWikiDocument {
    return {
        status: 'active',
        sourceMessageIds: [],
        updated: '2026-08-16T00:00:00.000Z',
        links: [],
        contextMode: 'auto',
        contentHash: `hash-${input.id}`,
        ...input,
    }
}

describe('progressive Markdown inquiry', () => {
    test('follows two derived wiki-link hops from a lexical character seed', () => {
        const result = inquireMarkdownDocuments({
            currentInput: '프로도가 쉘롭에게 공격당한다. 대항할 물건은 무엇인가?',
            documents: [
                document({
                    id: 'frodo', type: 'character', title: '프로도',
                    relativePath: 'characters/frodo.md',
                    content: '# 프로도\n\n## 현재 소지품\n\n- [[에아렌딜의 유리병]]',
                    links: ['에아렌딜의 유리병'],
                }),
                document({
                    id: 'phial', type: 'item', title: '에아렌딜의 유리병',
                    relativePath: 'items/phial.md',
                    content: '# 에아렌딜의 유리병\n\n## 효능\n\n어둠 속에서 강한 빛을 낸다.\n\n## 유래\n\n[[로스로리엔의 선물]]에서 받았다.',
                    links: ['로스로리엔의 선물'],
                }),
                document({
                    id: 'gift', type: 'event', title: '로스로리엔의 선물',
                    relativePath: 'events/gift.md',
                    content: '# 로스로리엔의 선물\n\n갈라드리엘이 훗날 가장 어두운 순간에 쓰라며 유리병을 건넸다.',
                }),
                document({
                    id: 'unrelated', type: 'event', title: '곤도르의 회의',
                    relativePath: 'events/council.md',
                    content: '# 곤도르의 회의\n\n섭정들이 국경 문제를 논의했다.',
                }),
            ],
        })

        expect(result.sources.map((source) => source.id)).toEqual(
            expect.arrayContaining([
                'narrative-memory:wiki:characters/frodo.md',
                'narrative-memory:wiki:items/phial.md',
                'narrative-memory:wiki:events/gift.md',
            ])
        )
        expect(result.sources.some((source) =>
            source.id.endsWith('events/council.md'))).toBe(false)
        expect(result.metrics.hopCount).toBe(2)
        expect(result.metrics.inspectedEdgeCount).toBeGreaterThanOrEqual(2)
        expect(result.metrics.auxiliaryModelCalls).toBe(0)
    })

    test('returns the matching section instead of an unrelated document prefix', () => {
        const irrelevant = '오래된 무관한 기록이다. '.repeat(240)
        const result = inquireMarkdownDocuments({
            currentInput: '에아렌딜의 유리병은 어디에서 유래했지?',
            documents: [document({
                id: 'phial', type: 'item', title: '별빛 유물',
                relativePath: 'items/phial.md',
                content: `# 별빛 유물\n\n${irrelevant}\n\n## 유래\n\n에아렌딜의 별빛을 담았으며 갈라드리엘이 프로도에게 건넸다.`,
            })],
        })

        expect(result.sources).toHaveLength(1)
        expect(result.sources[0]?.content).toContain('## 유래')
        expect(result.sources[0]?.content).toContain('갈라드리엘')
        expect(result.sources[0]?.content.length).toBeLessThanOrEqual(2_000)
        expect(result.sources[0]?.content).not.toContain(irrelevant.slice(0, 2_000))
    })

    test('bounds traversal candidates, selected documents, excerpts, and tokens', () => {
        const linked = Array.from({ length: 80 }, (_, index) =>
            document({
                id: `item-${index}`, type: 'item', title: `유물 ${index}`,
                relativePath: `items/item-${index}.md`,
                content: `# 유물 ${index}\n\n${'상세 정보 '.repeat(500)}`,
            }))
        const result = inquireMarkdownDocuments({
            currentInput: '프로도의 유물',
            documents: [
                document({
                    id: 'frodo', type: 'character', title: '프로도',
                    relativePath: 'characters/frodo.md',
                    content: `# 프로도\n\n${linked.map((item) =>
                        `[[${item.title}]]`).join(' ')}`,
                    links: linked.map((item) => item.title),
                }),
                ...linked,
            ],
        })

        expect(result.metrics.candidateCount).toBeLessThanOrEqual(64)
        expect(result.metrics.inspectedEdgeCount).toBeLessThanOrEqual(256)
        expect(result.sources.length).toBeLessThanOrEqual(12)
        expect(result.sources.every((source) =>
            source.content.length <= 2_000)).toBe(true)
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(2_000)
    })

    test('does not retrieve documents from conversational stopwords alone', () => {
        const result = inquireMarkdownDocuments({
            currentInput: '그는 지금 무엇을 해야 하지?',
            documents: Array.from({ length: 20 }, (_, index) => document({
                id: `note-${index}`,
                type: 'other',
                title: `기록 ${index}`,
                relativePath: `notes/note-${index}.md`,
                content: `# 기록 ${index}\n\n그는 조용히 방 안에 있었다.`,
            })),
        })

        expect(result.sources).toEqual([])
        expect(result.metrics.candidateCount).toBe(0)
    })

    test('uses a compact default budget instead of filling the hard limit', () => {
        const result = inquireMarkdownDocuments({
            currentInput: '프로도에 대한 관련 정보를 알려 줘.',
            documents: [
                document({
                    id: 'frodo', type: 'character', title: '프로도',
                    relativePath: 'characters/frodo.md',
                    content: '# 프로도\n\n호빗 반지 운반자다.',
                }),
                ...Array.from({ length: 12 }, (_, index) => document({
                    id: `frodo-event-${index}`,
                    type: 'event',
                    title: `프로도의 사건 ${index}`,
                    relativePath: `events/frodo-${index}.md`,
                    content: `# 프로도의 사건 ${index}\n\n프로도는 길을 걸었다.\n\n${'상세 사건 기록 '.repeat(260)}`,
                })),
            ],
        })

        expect(result.sources[0]?.id).toBe(
            'narrative-memory:wiki:characters/frodo.md'
        )
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(2_000)
    })

    test('answers chronology intent from the compressed character history', () => {
        const result = inquireMarkdownDocuments({
            currentInput: '프로도의 모험과 작중 행적을 순서대로 나열해 줘.',
            documents: [
                document({
                    id: 'frodo', type: 'character', title: '프로도',
                    relativePath: 'characters/frodo.md',
                    content: [
                        '# 프로도',
                        '',
                        '## 작중 행적',
                        '',
                        '- [[샤이어 출발]]: 샘과 함께 고향을 떠났다.',
                        '- [[반지원정대 결성]]: 반지를 파괴할 책임을 맡았다.',
                        '- [[원정대 이탈]]: 샘과 둘이 모르도르로 향했다.',
                    ].join('\n'),
                    links: ['샤이어 출발', '반지원정대 결성', '원정대 이탈'],
                }),
                ...['샤이어 출발', '반지원정대 결성', '원정대 이탈']
                    .map((title, index) => document({
                        id: `event-${index}`, type: 'event', title,
                        relativePath: `events/event-${index}.md`,
                        content: `# ${title}\n\n프로도의 상세 사건 기록이다.`,
                    })),
            ],
        })

        expect(result.sources.map((source) => source.id)).toEqual([
            'narrative-memory:wiki:characters/frodo.md',
        ])
        expect(result.sources[0]?.content).toContain('## 작중 행적')
    })

    test('counts Korean text against the token budget instead of a character heuristic', () => {
        const documents = Array.from({ length: 4 }, (_, index) => document({
            id: `required-${index}`,
            type: 'concept',
            title: `필수 문서 ${index}`,
            relativePath: `concepts/required-${index}.md`,
            content: `# 필수 문서 ${index}\n\n${'가'.repeat(2_000)}`,
            contextMode: 'always',
        }))

        expect(() => inquireMarkdownDocuments({
            currentInput: '계속 진행한다.',
            documents,
        })).toThrow('Required wiki context exceeds token budget')
    })

    test('uses request budgets without changing retrieval relevance', () => {
        const result = inquireMarkdownDocuments({
            currentInput: '필수 설정을 확인한다.',
            tokenBudget: { target: 256, maximum: 512 },
            documents: [document({
                id: 'required', type: 'concept', title: '필수 설정',
                relativePath: 'concepts/required.md',
                content: `# 필수 설정\n\n${'가'.repeat(300)}`,
                contextMode: 'always',
            })],
        })

        expect(result.sources).toHaveLength(1)
        expect(result.metrics.selectedTokens).toBeGreaterThan(256)
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(512)
    })
})
