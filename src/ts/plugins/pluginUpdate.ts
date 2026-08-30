/**
 * Plugin updating, and the two things it has to get right.
 *
 * IDENTITY. A plugin used to be identified by its `//@name`, so an update whose
 * source declared a different name resolved to whichever *other* installed
 * plugin happened to carry that name -- a user watched `risu_multiagent` receive
 * `flashback_memory`. `pluginId` is the install's own identity: a UUID minted
 * when the plugin is installed and carried across every later update, so a
 * rename moves the record's name and nothing else.
 *
 * REPORTING. Every failure used to collapse into `false`, so "the server is
 * down", "the file no longer parses" and "it was already up to date" were the
 * same non-event on screen. `PluginUpdateResult` names which one happened and
 * carries the underlying error, so the caller can say it out loud.
 */

export interface PluginUpdateTarget {
    /** Stable install identity. Absent only for a record predating identities. */
    id?: string
    name: string
    updateURL?: string
}

export interface InstalledPluginSnapshot {
    id?: string
    name: string
    script: string
}

/** What `importPlugin` reports back about one install attempt. */
export interface PluginImportOutcome {
    ok: boolean
    /** The message already shown to the user, when the import refused. */
    reason?: string
}

export type PluginUpdateFailure =
    /** The plugin declares no `//@update-url`, so there is nothing to check. */
    | { kind: 'no-update-url' }
    /** The download did not succeed. `status` is 0 for a transport failure. */
    | { kind: 'download-failed', status: number, error?: unknown }
    /** The installer refused the downloaded source and said why. */
    | { kind: 'rejected', detail: string }
    /** The installed source is already identical to what the server serves. */
    | { kind: 'already-current' }
    /**
     * The installer reported success but the stored script is not the
     * downloaded one -- including the case where the record cannot be found at
     * all after the import. Partial is not absent: this is reported, never
     * treated as "nothing to do".
     */
    | { kind: 'not-installed', detail: string }
    /** The update threw. The error is carried, not flattened. */
    | { kind: 'threw', error: unknown }

export type PluginUpdateSuccess = { ok: true }
export type PluginUpdateRefusal = { ok: false, failure: PluginUpdateFailure }
export type PluginUpdateResult = PluginUpdateSuccess | PluginUpdateRefusal

/**
 * The project compiles with `strict: false`, where narrowing a union on a
 * boolean discriminant is not dependable. An explicit guard is, and it keeps
 * `failure` off the success arm rather than making it optional everywhere.
 */
export function isPluginUpdateRefusal(result: PluginUpdateResult): result is PluginUpdateRefusal {
    return result.ok === false
}

export interface PluginUpdateDependencies {
    fetcher: (url: string, init?: RequestInit) => Promise<Response>
    importer: (source: string, target: PluginUpdateTarget) => Promise<PluginImportOutcome | void>
    /**
     * Resolve the installed record for this update by its stable identity.
     * Returning `undefined` means "no such install", which is why the failure
     * kinds distinguish it from "installed, but not the new source".
     */
    readInstalled: (target: PluginUpdateTarget) => InstalledPluginSnapshot | undefined
}

/** Ready-to-show text naming the cause. Never returns an empty string. */
export function describePluginUpdateFailure(failure: PluginUpdateFailure): string {
    switch (failure.kind) {
        case 'no-update-url':
            return 'This plugin declares no //@update-url, so there is nothing to update from.'
        case 'download-failed':
            return failure.status > 0
                ? `Downloading the update failed (HTTP ${failure.status}).`
                : `Downloading the update failed: ${errorText(failure.error)}`
        case 'rejected':
            return `The downloaded plugin was refused: ${failure.detail}`
        case 'already-current':
            return 'The installed version is already identical to the published one.'
        case 'not-installed':
            return `The update was downloaded but is not what ended up installed: ${failure.detail}`
        case 'threw':
            return `The update failed: ${errorText(failure.error)}`
    }
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message || error.name || 'Unknown error'
    if (typeof error === 'string' && error) return error
    try {
        const serialized = JSON.stringify(error)
        if (serialized && serialized !== '{}') return serialized
    } catch (serializationError) {
        return `Unserializable error (${String(serializationError)})`
    }
    return String(error)
}

export async function runPluginUpdate(
    plugin: PluginUpdateTarget,
    dependencies: PluginUpdateDependencies,
): Promise<PluginUpdateResult> {
    if (!plugin.updateURL) return { ok: false, failure: { kind: 'no-update-url' } }

    try {
        let response: Response
        try {
            response = await dependencies.fetcher(plugin.updateURL, { cache: 'no-store' })
        } catch (error) {
            return { ok: false, failure: { kind: 'download-failed', status: 0, error } }
        }
        if (!response.ok) {
            return { ok: false, failure: { kind: 'download-failed', status: response.status } }
        }

        const source = await response.text()
        const previousSource = dependencies.readInstalled(plugin)?.script
        const outcome = await dependencies.importer(source, plugin)
        if (outcome && !outcome.ok) {
            return { ok: false, failure: { kind: 'rejected', detail: outcome.reason ?? 'the installer gave no reason' } }
        }

        // Resolve by identity, not by name: an update is allowed to rename the
        // plugin, and looking the result up by the new name would find some
        // other install (or nothing) and call a good update a failure.
        const installed = dependencies.readInstalled(plugin)
        if (!installed) {
            return {
                ok: false,
                failure: {
                    kind: 'not-installed',
                    detail: `no installed plugin matches ${describeTarget(plugin)} after the import`,
                },
            }
        }
        if (installed.script !== source) {
            return {
                ok: false,
                failure: {
                    kind: 'not-installed',
                    detail: `"${installed.name}" still holds a different script`,
                },
            }
        }
        if (previousSource === source) return { ok: false, failure: { kind: 'already-current' } }
        return { ok: true }
    } catch (error) {
        console.error('Failed to update plugin:', error)
        return { ok: false, failure: { kind: 'threw', error } }
    }
}

function describeTarget(plugin: PluginUpdateTarget): string {
    return plugin.id ? `id ${plugin.id} ("${plugin.name}")` : `"${plugin.name}"`
}
