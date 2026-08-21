import { describe, expect, test } from 'vitest'
import {
    canonicalBatchSchema,
    memoryWriterDraftSchema,
    memoryWriterSystemPrompt,
    hasMemoryWriterContent,
    parseMemoryWriterDraft,
    serializeMemoryWriterDraft,
} from './risubard-memory-writer'

describe('BardWiki memory writer skill', () => {
    test('loads the project-owned skill and its hard recording rules', () => {
        expect(memoryWriterSystemPrompt).toContain('bardwiki-memory-writer')
        expect(memoryWriterSystemPrompt).toContain('사용자 지시문은 사건의 근거가 아니다')
        expect(memoryWriterSystemPrompt).toContain('ID, 파일 경로, revision, hash')
        expect(memoryWriterSystemPrompt).toContain('인물별 지식')
        expect(memoryWriterSystemPrompt).toContain('독립적인 이야기 요약')
    })

    test('teaches general narrative value and omission-cost judgment', () => {
        expect(memoryWriterSystemPrompt).toContain('향후 서사')
        expect(memoryWriterSystemPrompt).toContain('누락 비용')
        expect(memoryWriterSystemPrompt).toContain('대표되지 않은')
        expect(memoryWriterSystemPrompt).not.toContain(
            '명시적인 프로필이 나온 인물을 모두 포함'
        )
    })

    test('gates canonical rewrites on concrete durable changes', () => {
        expect(memoryWriterSystemPrompt).toContain('구체적인 지속 변화')
        expect(memoryWriterSystemPrompt).toContain('사건 문서만으로 충분한 행동')
        expect(memoryWriterSystemPrompt).toContain('정본 후보를 만들지 마라')
        expect(memoryWriterSystemPrompt).toContain('소지품')
        expect(memoryWriterSystemPrompt).toContain('인물별 지식')
        expect(memoryWriterSystemPrompt).toContain('중요한 인과 전환점')
        expect(memoryWriterSystemPrompt).toContain('누락하지 마라')
    })

    test('publishes a strict bounded JSON schema', () => {
        const schema = JSON.parse(memoryWriterDraftSchema)
        expect(schema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: [
                'schemaVersion',
                'title',
                'establishedEvents',
                'stateChanges',
                'characterKnowledge',
                'persistentFacts',
                'openContinuity',
                'canonicalUpdateCandidates',
            ],
        })
        expect(schema.properties.establishedEvents.maxItems).toBe(12)
        expect(schema.properties.schemaVersion).toEqual({ const: 1 })
        expect(JSON.parse(canonicalBatchSchema).properties.schemaVersion)
            .toEqual({ const: 1 })
        expect(schema.properties.characterKnowledge.items.properties.stance)
            .toMatchObject({ type: 'string' })
        expect(schema.properties.canonicalUpdateCandidates.items.properties.type)
            .toMatchObject({ type: 'string' })
        expect(schema.properties.canonicalUpdateCandidates.items.properties.action)
            .toMatchObject({ type: 'string' })
    })

    test('validates a semantic draft and serializes deterministic Markdown', () => {
        const draft = parseMemoryWriterDraft(JSON.stringify({
            schemaVersion: 1,
            title: '성문 도착',
            establishedEvents: ['[[라비안]]이 [[케사리아]] 성문에 도착했다.'],
            stateChanges: [{
                subject: '[[라비안]]',
                before: '케사리아로 이동 중',
                after: '케사리아 성문에 있음',
            }],
            characterKnowledge: [{
                character: '[[라비안]]',
                fact: '성문이 봉쇄되었다.',
                stance: 'knows',
            }],
            persistentFacts: ['성문은 현재 봉쇄 상태다.'],
            openContinuity: ['봉쇄 이유는 아직 밝혀지지 않았다.'],
            canonicalUpdateCandidates: [{
                type: 'location',
                title: '케사리아',
                reason: '성문 봉쇄 상태가 새로 확정되었다.',
                action: 'update',
                targetDocumentId: 'location.caesarea',
                confidence: 0.94,
            }],
        }))

        expect(serializeMemoryWriterDraft(draft)).toBe([
            '## 성문 도착',
            '',
            '### 이야기 요약',
            '',
            '- [[라비안]]이 [[케사리아]] 성문에 도착했다.',
        ].join('\n'))
    })

    test('normalizes Gemini operation as the canonical action field', () => {
        const draft = parseMemoryWriterDraft(JSON.stringify({
            schemaVersion: 1,
            title: '장면 변화',
            establishedEvents: ['장면이 바뀌었다.'],
            stateChanges: [],
            characterKnowledge: [],
            persistentFacts: [],
            openContinuity: [],
            canonicalUpdateCandidates: [{
                type: 'scene',
                title: '현재 장면',
                reason: '장면이 바뀌었다.',
                operation: 'create',
                targetDocumentId: null,
                confidence: 0.9,
            }],
        }))

        expect(draft.canonicalUpdateCandidates[0].action).toBe('create')
    })

    test('requires an explicit create/update decision and target identity', () => {
        const invalid = {
            schemaVersion: 1,
            title: '성문 도착',
            establishedEvents: ['도착했다.'],
            stateChanges: [],
            characterKnowledge: [],
            persistentFacts: [],
            openContinuity: [],
            canonicalUpdateCandidates: [{
                type: 'location',
                title: '케사리아 외곽 폐촌',
                reason: '장소 상태가 확정되었다.',
            }],
        }
        expect(() => parseMemoryWriterDraft(JSON.stringify(invalid)))
            .toThrow(/action|targetDocumentId|confidence/)
    })

    test('rejects unknown fields and empty evidence sections', () => {
        expect(() => parseMemoryWriterDraft(JSON.stringify({
            schemaVersion: 1,
            title: '빈 기록',
            establishedEvents: [],
            stateChanges: [],
            characterKnowledge: [],
            persistentFacts: [],
            openContinuity: [],
            canonicalUpdateCandidates: [],
            markdown: '# injected',
        }))).toThrow(/field|supported memory/i)
    })

    test('represents a no-change result without fabricating an event', () => {
        const draft = parseMemoryWriterDraft(JSON.stringify({
            schemaVersion: 1,
            title: '변화 없음',
            establishedEvents: [],
            stateChanges: [],
            characterKnowledge: [],
            persistentFacts: [],
            openContinuity: [],
            canonicalUpdateCandidates: [],
        }))
        expect(hasMemoryWriterContent(draft)).toBe(false)
    })
})
