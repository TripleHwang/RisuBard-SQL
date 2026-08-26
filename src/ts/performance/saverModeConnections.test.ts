import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('saver mode runtime connections', () => {
    it('passes the reactive saver state into the chat DOM window', () => {
        const screen = source('src/lib/ChatScreens/DefaultChatScreen.svelte')
        expect(screen).toContain("import { saverModeStore } from 'src/ts/performance/saverMode'")
        expect(screen).toContain('saverMode={$saverModeStore}')
    })

    it('only forces strong streaming at stream start from the saver snapshot', () => {
        const process = source('src/ts/process/index.svelte.ts')
        const snapshot = process.indexOf("const performanceMode: StreamingDisplayOptimizationMode = get(saverModeStore)")
        expect(snapshot).toBeGreaterThan(-1)
        expect(process.slice(snapshot, snapshot + 250)).toContain("? 'strong'")
        expect(process.slice(snapshot, snapshot + 250)).toContain('streamingDisplayOptimizationMode')
    })
})
