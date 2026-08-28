import { describe, expect, it } from 'vitest'
import { isCanonicalFilesChangedResponse } from './canonicalConflict'

describe('canonical file conflict response', () => {
    it('recognizes only the server external-file conflict contract', () => {
        expect(isCanonicalFilesChangedResponse).toBeTypeOf('function')
        expect(isCanonicalFilesChangedResponse({ code: 'CANONICAL_FILES_CHANGED' })).toBe(true)
        expect(isCanonicalFilesChangedResponse({ canonicalFilesChanged: true })).toBe(true)
        expect(isCanonicalFilesChangedResponse({ code: 'CHAT_GUARD_REJECTED' })).toBe(false)
        expect(isCanonicalFilesChangedResponse(null)).toBe(false)
    })
})
