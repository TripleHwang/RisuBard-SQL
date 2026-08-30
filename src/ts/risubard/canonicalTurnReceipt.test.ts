import { describe, expect, test } from 'vitest'
import {
    canonicalTurnNeedsRetry,
    formatCanonicalUpdateFailureWarning,
} from './canonicalTurnReceipt'

describe('canonical turn retry receipt', () => {
    test('marks a provider timeout as retryable without exposing unbounded details', () => {
        const warning = formatCanonicalUpdateFailureWarning(
            new Error('Upstream request timed out after 300000ms')
        )

        expect(warning).toContain('타임아웃')
        expect(warning).toContain('다음 턴에 자동으로 다시 시도합니다')
        expect(canonicalTurnNeedsRetry({
            sourceMessageIds: ['assistant-1'],
            eventIds: ['event-1'],
            changes: [],
            warnings: [warning],
            recordedAt: '2026-08-31T00:00:00.000Z',
        })).toBe(true)
    })

    test('keeps a successful receipt complete', () => {
        expect(canonicalTurnNeedsRetry({
            sourceMessageIds: ['assistant-1'],
            eventIds: ['event-1'],
            changes: [],
            warnings: [],
            recordedAt: '2026-08-31T00:00:00.000Z',
        })).toBe(false)
    })
})
