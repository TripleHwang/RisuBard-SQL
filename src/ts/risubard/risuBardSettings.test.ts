import { describe, expect, test } from 'vitest'
import {
    RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT,
    RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT,
    RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT,
    RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT,
    RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT,
    RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT,
    buildRisuBardCanonicalWritingPolicy,
    normalizeRisuBardAnalysisTokenLimit,
    normalizeRisuBardAdditionalSearchLimit,
    normalizeRisuBardCanonicalCustomStyle,
    normalizeRisuBardCanonicalTargetLimit,
    normalizeRisuBardCanonicalWritingStyle,
    normalizeRisuBardInquiryTokenBudget,
    resolveRisuBardChatSettings,
} from './risuBardSettings'

describe('RisuBard analysis settings', () => {
    test('uses conservative defaults for missing and invalid values', () => {
        expect(normalizeRisuBardAnalysisTokenLimit(undefined))
            .toBe(RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT)
        expect(normalizeRisuBardAdditionalSearchLimit('2'))
            .toBe(RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT)
        expect(normalizeRisuBardCanonicalTargetLimit(Number.NaN))
            .toBe(RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT)
    })

    test('clamps integer values to the supported bounded ranges', () => {
        expect(normalizeRisuBardAnalysisTokenLimit(12)).toBe(3_072)
        expect(normalizeRisuBardAnalysisTokenLimit(99_999)).toBe(32_768)
        expect(normalizeRisuBardAdditionalSearchLimit(-3)).toBe(0)
        expect(normalizeRisuBardAdditionalSearchLimit(99)).toBe(4)
        expect(normalizeRisuBardCanonicalTargetLimit(0)).toBe(1)
        expect(normalizeRisuBardCanonicalTargetLimit(99)).toBe(8)
    })

    test('normalizes configurable inquiry target and maximum budgets', () => {
        expect(normalizeRisuBardInquiryTokenBudget(undefined, undefined))
            .toEqual({
                target: RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT,
                maximum: RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT,
            })
        expect(normalizeRisuBardInquiryTokenBudget(8_000, 4_000))
            .toEqual({ target: 4_000, maximum: 4_000 })
        expect(normalizeRisuBardInquiryTokenBudget(1, 99_999))
            .toEqual({ target: 256, maximum: 32_768 })
    })

    test('normalizes the shared canonical writing policy', () => {
        expect(normalizeRisuBardCanonicalWritingStyle(undefined))
            .toBe(RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT)
        expect(normalizeRisuBardCanonicalWritingStyle('standard')).toBe('standard')
        expect(normalizeRisuBardCanonicalWritingStyle('ultra-concise')).toBe('ultra-concise')
        expect(normalizeRisuBardCanonicalWritingStyle('invalid')).toBe('concise')
        expect(normalizeRisuBardCanonicalCustomStyle(`  ${'가'.repeat(1_200)}  `))
            .toBe('가'.repeat(1_000))
    })

    test('builds Korean style-only instructions without weakening memory rules', () => {
        expect(buildRisuBardCanonicalWritingPolicy('concise', '')).toContain(
            '사실 하나당 한 문장'
        )
        const custom = buildRisuBardCanonicalWritingPolicy(
            'custom',
            '항목마다 짧은 명사형으로 끝낸다.'
        )
        expect(custom).toContain('한국어로 작성')
        expect(custom).toContain('항목마다 짧은 명사형으로 끝낸다.')
        expect(custom).toContain('사실 선택, 근거, 구조 및 안전 규칙을 변경하지 않는다')
        expect(custom).not.toContain('undefined')
    })

    test('keeps character canon compact while preserving detailed event evidence', () => {
        const policy = buildRisuBardCanonicalWritingPolicy('concise', '')

        expect(policy).toContain('캐릭터 정본은 현재 상태')
        expect(policy).toContain('인과에 필요한 전환점')
        expect(policy).toContain('턴별 행동 기록을 누적하지 않는다')
        expect(policy).toContain('상세 과거 행적은 사건 문서')
        expect(policy).toContain('이전 상태를 현재 사실처럼 병기하지 않는다')
        expect(policy).toContain('### 작중 행적')
        expect(policy).toContain('최대 16개')
        expect(policy).toContain('[[사건 문서 제목]]')
    })

    test('resolves current-chat overrides over normalized global defaults', () => {
        const resolved = resolveRisuBardChatSettings({
            risuBardModelMode: 'memory',
            risuBardRecentMessageCount: 12,
            risuBardResponseMessageCount: 20,
            showRequestStatus: true,
        }, {
            risuBardModelMode: 'model',
            risuBardRecentMessageCount: 7,
            risuBardResponseExcludeUserMessages: true,
            showRequestStatus: false,
        })

        expect(resolved.risuBardModelMode).toBe('model')
        expect(resolved.risuBardRecentMessageCount).toBe(7)
        expect(resolved.risuBardResponseMessageCount).toBe(20)
        expect(resolved.risuBardResponseExcludeUserMessages).toBe(true)
        expect(resolved.showRequestStatus).toBe(false)
    })
})
