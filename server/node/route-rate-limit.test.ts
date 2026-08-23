import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')

describe('route rate limiting', () => {
    it('limits password attempts without throttling authenticated storage reads', () => {
        expect(server).toContain('const loginRouteLimiter = rateLimit({')
        expect(server).not.toContain('authenticatedRouteLimiter')
        expect(server).not.toMatch(/app\.use\([^\n]*rateLimit/)
    })
})
