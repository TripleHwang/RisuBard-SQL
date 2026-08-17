import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('Provider Manager RisuBard status bridge', () => {
    test('offers a persisted host status path and opts registered providers in dynamically', () => {
        const source = readFileSync(resolve(process.cwd(), '..', 'samples', 'provider-manager.js'), 'utf8')

        expect(source).toContain('RisuBardStatusBridge')
        expect(source).toContain('Yumi Provider Manager v1.13.0 [RisuBard Patch]')
        expect(source).toContain('provider-manager:risubard-status-path')
        expect(source.match(/hostRequestStatusStorageKey:RisuBardStatusBridge\.storageKey/g)).toHaveLength(4)
        expect(source).toContain('상태 카드 경로')
        expect(source).toContain('RisuBard 상세 주입·토큰 카드')
    })

    test('mounts the status path selector into the rendered floating-window section', async () => {
        const source = readFileSync(resolve(process.cwd(), '..', 'samples', 'provider-manager.js'), 'utf8')
        const bridge = source.slice(0, source.indexOf('!function(){'))
        document.body.innerHTML = `
            <div class="pm-container">
                <div class="pm-card">
                    <div class="pm-card-title">플로팅 윈도우</div>
                    <div class="pm-col"></div>
                </div>
            </div>
        `

        Function(bridge)()
        await Promise.resolve()

        expect(document.querySelector('#pm-risubard-status-path select')).not.toBeNull()
    })
})
