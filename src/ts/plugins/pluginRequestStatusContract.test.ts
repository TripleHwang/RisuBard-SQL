import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('plugin provider host request status contract', () => {
    test('applies the host status gate to every plugin-provider request', () => {
        const request = source('src/ts/process/request/request.ts')

        expect(request).toContain('const reportStatus = statusEnabled(arg.realChatId)')
        expect(request).toContain(
            'resolvePluginRequestStatus(pluginV2.providerOptions.get(model))',
        )
    })

    test('documents the default-on opt-out contract in both plugin APIs', () => {
        const runtime = source('src/ts/plugins/plugins.svelte.ts')
        const apiV3 = source('src/ts/plugins/apiV3/risuai.d.ts')
        const contract = 'host-rendered request status card is on by default; set false to opt out'

        expect(runtime).toContain(contract)
        expect(apiV3).toContain(contract)
    })
})
