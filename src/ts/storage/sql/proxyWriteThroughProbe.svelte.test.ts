import { describe, expect, it } from 'vitest'

/**
 * Probe, not a regression guard: establishes the runtime fact the whole
 * persistence bug rests on. Svelte 5's `$state` proxy does not write through to
 * the object it wraps, so anything that captured the raw object before it was
 * proxied is frozen at that instant.
 */
describe('svelte $state proxy write-through', () => {
    it('does not write through to the raw target object', () => {
        const raw = { username: 'before', nested: { detailsLoaded: false }, list: [] as string[] }
        const holder = $state({ db: raw })

        // `holder.db` is a proxy OF `raw`, not `raw` itself.
        expect(holder.db).not.toBe(raw)

        holder.db.username = 'after'
        holder.db.nested.detailsLoaded = true
        holder.db.list.push('message-1')

        // Reads through the proxy see every write.
        expect(holder.db.username).toBe('after')
        expect(holder.db.nested.detailsLoaded).toBe(true)
        expect(holder.db.list.length).toBe(1)

        // The raw object sees none of them.
        expect(raw.username).toBe('before')
        expect(raw.nested.detailsLoaded).toBe(false)
        expect(raw.list.length).toBe(0)
    })

    it('does not share symbol-keyed markers between raw object and proxy', () => {
        const marker = Symbol('runtime-marker')
        const raw: Record<string | symbol, unknown> = {}
        const holder = $state({ db: raw })

        raw[marker] = 'set-on-raw'
        // A symbol set on the raw object before proxying IS visible through the
        // proxy's get trap (it falls through to the target).
        expect((holder.db as Record<symbol, unknown>)[marker]).toBe('set-on-raw')

        ;(holder.db as Record<symbol, unknown>)[marker] = 'set-on-proxy'
        // But a symbol set through the proxy never reaches the raw object.
        expect((holder.db as Record<symbol, unknown>)[marker]).toBe('set-on-proxy')
        expect(raw[marker]).toBe('set-on-raw')
    })
})
