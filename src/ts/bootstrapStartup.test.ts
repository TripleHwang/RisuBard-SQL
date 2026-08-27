import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')
const appSource = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8')
const chatScreenSource = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')
const gateSource = readFileSync(resolve(process.cwd(), 'src/lib/Others/DeferredStartupGate.svelte'), 'utf8')
const mobileBodySource = readFileSync(resolve(process.cwd(), 'src/lib/Mobile/MobileBody.svelte'), 'utf8')
const sidebarSource = readFileSync(resolve(process.cwd(), 'src/lib/SideBars/Sidebar.svelte'), 'utf8')

describe('startup scheduling and degraded recovery', () => {
    it('marks the visible shell before deferred startup work and true interaction after hydration', () => {
        const interactive = source.indexOf("loadedStore.set(true)")
        const startup = source.slice(interactive)
        const plugins = source.indexOf('scheduleAfterFirstPaint(() => loadDeferredModules())')

        expect(interactive).toBeGreaterThan(-1)
        expect(startup).toMatch(/loadedStore\.set\(true\)[\s\S]*markPerformance\('first-visible-shell'\)[\s\S]*markPerformance\('first-interactive'\)/)
        expect(plugins).toBeGreaterThan(interactive)
        expect(source).toMatch(/await loadPlugins\(\)[\s\S]*catch[\s\S]*registerModelDynamic\(\)[\s\S]*moduleUpdate\(\)/)
        expect(source).toContain('scheduleAfterFirstPaint(() => cleanChunks(), 5_000)')
        expect(source).toContain('scheduleAfterFirstPaint(() => checkRisuUpdate().then(() => undefined))')
        expect(source).toContain('scheduleAfterFirstPaint(() => initModelJobRecovery())')
    })

    it('keeps metadata-first bootstrap from immediately serializing character summaries', () => {
        expect(source).toContain("startMetadataPersistence()")
        expect(source).not.toContain("saveDb({ metadataOnly: startupMode === 'metadata-first' })")
    })

    it('waits for deferred domains before normalizing a metadata-first database', () => {
        const shallowInstall = source.indexOf('if (deferredSqlStorage) setDatabaseLite(existingSql.database)')
        const scheduledHydration = source.indexOf('scheduleDeferredSqlHydration(() => hydrateDeferredSqlStartup(deferredSqlStorage!))')
        const deferredFunction = source.slice(
            source.indexOf('async function hydrateDeferredSqlStartup'),
            source.indexOf('async function activateCanonicalDatabase'),
        )

        expect(shallowInstall).toBeGreaterThan(-1)
        expect(scheduledHydration).toBeGreaterThan(shallowInstall)
        expect(deferredFunction).toMatch(/await storage\.hydrateDeferredDatabase\(getDatabase\(\)\)[\s\S]*setDatabase\(getDatabase\(\)\)[\s\S]*setPatchSyncBaseline\(safeStructuredClone\(getDatabase\(\)\)\)/)
        expect(source).toContain('setDatabaseLite(retried.database)')
    })

    it('keeps only mutation surfaces gated while the metadata-first shell remains usable', () => {
        const gate = source.indexOf('startupHydrationStore.set(Boolean(deferredSqlStorage))')
        const loaded = source.indexOf('loadedStore.set(true)')
        const scheduledHydration = source.indexOf('scheduleDeferredSqlHydration(() => hydrateDeferredSqlStartup(deferredSqlStorage!))')
        const deferredFunction = source.slice(
            source.indexOf('async function hydrateDeferredSqlStartup'),
            source.indexOf('async function activateCanonicalDatabase'),
        )

        expect(gate).toBeGreaterThan(-1)
        expect(gate).toBeLessThan(loaded)
        expect(scheduledHydration).toBeGreaterThan(loaded)
        expect(deferredFunction).toMatch(/startMetadataPersistence\(\)[\s\S]*startupHydrationStore\.set\(false\)[\s\S]*markPerformance\('deferred-hydration:end'\)/)
        expect(deferredFunction).toMatch(/while \(true\)[\s\S]*await storage\.hydrateDeferredDatabase\(getDatabase\(\)\)[\s\S]*startMetadataPersistence\(\)[\s\S]*startupHydrationStore\.set\(false\)/)
        const failurePath = deferredFunction.slice(deferredFunction.indexOf('catch (error)'))
        const failed = failurePath.indexOf("pluginStateStore.set('failed')")
        const prompt = failurePath.indexOf('await alertConfirm(')
        const continueRetry = failurePath.indexOf('continue')
        expect(failed).toBeGreaterThan(-1)
        expect(prompt).toBeGreaterThan(failed)
        expect(continueRetry).toBeGreaterThan(prompt)
        expect(failurePath).not.toContain('startupHydrationStore.set(false)')
        expect((deferredFunction.match(/hydrateDeferredDatabase/g) ?? [])).toHaveLength(1)
        expect(source).toContain("markPerformance('first-visible-shell')")
        expect(appSource).not.toContain('inert={$startupHydrationStore}')
        expect(appSource).toContain('<DeferredStartupGate>')
        expect(appSource).toContain('<MobileBody />')
    })

    it('labels snapshot recovery as degraded instead of silently loading a local snapshot', () => {
        expect(source).toContain("startupMode === 'degraded'")
        expect(source).toContain('loadRecoverySnapshot()')
        expect(source).toContain('Started in degraded compatibility mode')
        expect(source).toContain('Update the server to restore fast startup')
    })

    it('schedules SQL hydration immediately after two animation frames while keeping other work idle', () => {
        expect(source).toContain('export function scheduleAfterFirstPaint')
        expect(source).toMatch(/requestFrame\(\(\) => requestFrame\(/)
        expect(source).toContain('requestIdleCallback')
        expect(source).toMatch(/Promise\.resolve\(\)\.then\(task\)\.catch\(console\.error\)/)
        expect(source).toContain('export function scheduleDeferredSqlHydration')
        const hydrationScheduler = source.slice(
            source.indexOf('export function scheduleDeferredSqlHydration'),
            source.indexOf('async function loadDeferredModules'),
        )
        expect(hydrationScheduler).not.toContain('requestIdleCallback')
        expect(source).toContain('scheduleDeferredSqlHydration(() => hydrateDeferredSqlStartup(deferredSqlStorage!))')
    })

    it('does not run character-only format mutation for metadata summaries', () => {
        expect(source).toContain("if (startupMode !== 'metadata-first')")
        expect(source).toContain('await checkNewFormat()')
    })

    it('keeps the chat surface mounted and makes settings loaders full-inset overlays', () => {
        expect(chatScreenSource).not.toContain('DeferredStartupGate')
        expect(gateSource).toContain('absolute inset-0')
        expect(gateSource).toContain('animate-spin')
        expect(gateSource).not.toContain('m-4 rounded-md')
        expect(mobileBodySource).not.toContain('$startupHydrationStore && ($MobileSideBar > 0 || $selectedCharID !== -1 || $MobileGUIStack === 2)')
        expect(mobileBodySource).toContain('{:else if $selectedCharID !== -1}')
        const vaultGate = sidebarSource.slice(sidebarSource.indexOf('{#if $characterVaultOpen}'), sidebarSource.indexOf('<ShDialog'))
        expect(vaultGate).toContain('<DeferredStartupGate>')
        const deferredFailure = source.slice(source.indexOf("startupHydrationErrorStore.set(true)"), source.indexOf('if (!retry)'))
        expect(deferredFailure).toMatch(/clearDeferredCharacterSelection\(\)[\s\S]*await alertConfirm/)
    })
})
