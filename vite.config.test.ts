import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import viteConfig from './vite.config'

function serveConfig() {
    if (typeof viteConfig !== 'function') throw new Error('Expected a Vite config factory')
    return viteConfig({
        command: 'serve',
        mode: 'development',
        isSsrBuild: false,
        isPreview: false,
    })
}

describe('development workflow', () => {
    test('offers a Node watch command for automatic backend restarts', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

        expect(pkg.scripts['dev:server']).toBe(
            'node --watch --watch-preserve-output server/node/server.cjs',
        )
    })

    test('proxies backend HTTP and WebSocket routes from the Vite server', () => {
        const proxy = serveConfig().server?.proxy as Record<string, { target?: string; ws?: boolean }>

        expect(proxy['/api']?.target).toBe('http://localhost:6001')
        expect(proxy['/proxy']?.target).toBe('http://localhost:6001')
        expect(proxy['/hub-proxy']?.target).toBe('http://localhost:6001')
        expect(proxy['/proxy-stream-jobs']).toMatchObject({
            target: 'http://localhost:6001',
            ws: true,
        })
    })

    test('marks the HMR page as connected to the Node backend', async () => {
        const plugins = serveConfig().plugins?.flat().filter(Boolean) ?? []
        const plugin = plugins.find(candidate => candidate && typeof candidate === 'object'
            && 'name' in candidate && candidate.name === 'risubard-node-dev-globals')
        if (!plugin || !('transformIndexHtml' in plugin) || typeof plugin.transformIndexHtml !== 'function') {
            throw new Error('Missing development globals plugin')
        }

        const html = await plugin.transformIndexHtml('<html><head></head><body></body></html>')
        expect(String(html)).toContain('globalThis.__NODE__ = true')
        expect(String(html)).toContain('globalThis.__PATCH_SYNC__ = true')
    })
})
