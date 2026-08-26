import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('standalone runtime index route', () => {
    it('injects Node runtime flags for both root and direct index navigations before static files', () => {
        const source = readFileSync('server/node/server.cjs', 'utf8')
        const runtimeRoute = source.indexOf("app.get(['/', '/index.html']")
        const staticFiles = source.indexOf("app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));")

        expect(runtimeRoute).toBeGreaterThan(-1)
        expect(staticFiles).toBeGreaterThan(runtimeRoute)
        expect(source.slice(runtimeRoute, staticFiles)).toContain('globalThis.__NODE__ = true')
        expect(source.slice(runtimeRoute, staticFiles)).toContain('globalThis.__PATCH_SYNC__')
    })
})
