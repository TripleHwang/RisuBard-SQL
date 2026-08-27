import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bootstrapSource = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')
const gateSource = readFileSync(resolve(process.cwd(), 'src/lib/Others/DeferredStartupGate.svelte'), 'utf8')
const appSource = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8')
const charactersSource = readFileSync(resolve(process.cwd(), 'src/ts/characters.ts'), 'utf8')

describe('recovering from a declined deferred-startup retry', () => {
    it('keeps a handle on the deferred storage so hydration can be re-run', () => {
        const record = bootstrapSource.indexOf('deferredSqlStartupStorage = deferredSqlStorage')
        const register = bootstrapSource.indexOf('registerDeferredStartupRetry(deferredSqlStorage ? runDeferredSqlStartupRetry : null)')
        const schedule = bootstrapSource.indexOf('scheduleDeferredSqlHydration(() => hydrateDeferredSqlStartup(deferredSqlStorage!))')

        expect(record).toBeGreaterThan(-1)
        expect(register).toBeGreaterThan(record)
        expect(schedule).toBeGreaterThan(register)
        expect(bootstrapSource).toContain('export async function runDeferredSqlStartupRetry')
    })

    it('reopens the gate before re-running hydration so the error state is not terminal', () => {
        const retry = bootstrapSource.slice(
            bootstrapSource.indexOf('export async function runDeferredSqlStartupRetry'),
            bootstrapSource.indexOf('async function hydrateDeferredSqlStartup'),
        )

        expect(retry).toMatch(/startupHydrationErrorStore\.set\(false\)[\s\S]*await hydrateDeferredSqlStartup\(storage\)/)
        // Re-entrancy guard: a second click must not start a parallel hydration.
        expect(retry).toContain('if (!storage || deferredSqlStartupRunning) return false')
    })

    it('leaves nothing parked when the user declines the startup retry prompt', () => {
        const decline = bootstrapSource.slice(
            bootstrapSource.indexOf('if (!retry)'),
            bootstrapSource.indexOf('continue'),
        )

        // resumeDeferredCharacterSelection() has exactly one call site, below the
        // early return here, so anything still queued could never be resumed.
        expect(decline).toContain('clearDeferredCharacterSelection()')
        expect(bootstrapSource.match(/await resumeDeferredCharacterSelection\(\)/g) ?? []).toHaveLength(1)
    })

    it('offers a way out from inside the gate itself, without unmounting the gate', () => {
        expect(gateSource).toContain('retryDeferredSqlStartup')
        expect(gateSource).toContain('location.reload()')
        // A component that App.svelte imports must not drag bootstrap's module
        // graph in behind it; the retry hook lives in a zero-import leaf.
        expect(gateSource).toContain("from 'src/ts/deferredStartupRetry'")
        expect(gateSource).not.toContain("from 'src/ts/bootstrap'")
        // The gate still blocks its slot while hydration is pending or failed.
        expect(gateSource).toContain('{#if $startupHydrationStore}')
        expect(gateSource).toContain('<slot />')
        // Positioning semantics are unchanged: every consumer (desktop and
        // mobile settings, Quick Settings, Vault, popups) still gets the same
        // full-inset overlay it was written against.
        expect(gateSource).toContain('absolute inset-0 z-50')
        expect(gateSource).toContain('animate-spin')
        const errorBranch = gateSource.slice(
            gateSource.indexOf('{#if $startupHydrationErrorStore}'),
            gateSource.indexOf('{:else}'),
        )
        expect(errorBranch).toContain('savedSettingsLoadError')
        expect(errorBranch).not.toContain('animate-spin')
    })

    it('still routes popups through the gate, which is why the gate must be escapable', () => {
        expect(appSource).toContain('<DeferredStartupGate><PopupList /></DeferredStartupGate>')
        expect(appSource).toContain('<DeferredStartupGate><PopupEditor /></DeferredStartupGate>')
    })

    it('refuses selections that could never be resumed instead of parking them', () => {
        const changeChar = charactersSource.slice(
            charactersSource.indexOf('export async function changeChar'),
            charactersSource.indexOf('/** Resumes the newest safe-shell selection'),
        )
        const refusal = changeChar.slice(changeChar.indexOf('if (!startupReady && !isDeferredStartupResumable())'))

        expect(charactersSource).toContain('function isDeferredStartupResumable()')
        // Releases anything an older, now superseded selection was holding.
        expect(refusal.indexOf('clearDeferredCharacterSelection()')).toBeGreaterThan(-1)
        expect(refusal.indexOf('alertError')).toBeGreaterThan(-1)
        // The refusal happens before the overlay is ever raised.
        expect(changeChar.indexOf('if (!startupReady && !isDeferredStartupResumable())'))
            .toBeLessThan(changeChar.indexOf('loadingOverlayStore.set({ active: true'))
        // Every non-hand-off exit gives the overlay back.
        expect(changeChar).toContain("if (ownsOverlay && intent === characterSelectionIntent) loadingOverlayStore.set({ active: false, text: '', onCancel: null })")
        expect(changeChar).toContain('onCancel: () => clearDeferredCharacterSelection()')
    })
})
