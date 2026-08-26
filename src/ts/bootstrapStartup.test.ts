import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')

describe('startup scheduling and degraded recovery', () => {
    it('marks first interactive before noncritical startup work is scheduled', () => {
        const interactive = source.indexOf("loadedStore.set(true)")
        const mark = source.indexOf("markPerformance('first-interactive')")
        const plugins = source.indexOf('scheduleAfterFirstPaint(() => loadDeferredModules())')

        expect(interactive).toBeGreaterThan(-1)
        expect(mark).toBeGreaterThan(interactive)
        expect(plugins).toBeGreaterThan(mark)
        expect(source).toMatch(/await loadPlugins\(\)[\s\S]*registerModelDynamic\(\)[\s\S]*moduleUpdate\(\)/)
        expect(source).toContain('scheduleAfterFirstPaint(() => cleanChunks(), 5_000)')
        expect(source).toContain('scheduleAfterFirstPaint(() => checkRisuUpdate().then(() => undefined))')
        expect(source).toContain('scheduleAfterFirstPaint(() => initModelJobRecovery())')
    })

    it('keeps metadata-first bootstrap from immediately serializing character summaries', () => {
        expect(source).toContain("saveDb({ metadataOnly: startupMode === 'metadata-first' })")
    })

    it('labels snapshot recovery as degraded instead of silently loading a local snapshot', () => {
        expect(source).toContain("startupMode === 'degraded'")
        expect(source).toContain('loadRecoverySnapshot()')
        expect(source).toContain('Started in degraded compatibility mode')
        expect(source).toContain('Update the server to restore fast startup')
    })

    it('uses a double-animation-frame scheduler with idle and timeout fallbacks', () => {
        expect(source).toContain('export function scheduleAfterFirstPaint')
        expect(source).toMatch(/requestFrame\(\(\) => requestFrame\(/)
        expect(source).toContain('requestIdleCallback')
        expect(source).toMatch(/Promise\.resolve\(\)\.then\(task\)\.catch\(console\.error\)/)
    })

    it('does not run character-only format mutation for metadata summaries', () => {
        expect(source).toContain("if (startupMode !== 'metadata-first')")
        expect(source).toContain('await checkNewFormat()')
    })
})
