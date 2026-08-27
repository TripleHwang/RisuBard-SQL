export interface PluginUpdateTarget {
    name: string
    updateURL?: string
}

export interface InstalledPluginSnapshot {
    name: string
    script: string
    versionOfPlugin?: string
    updateURL?: string
}

/**
 * Which phase of the update pipeline a failure came from. Kept intentionally
 * small so every call site can `switch` on it instead of pattern-matching a
 * free-form string.
 */
export type PluginUpdateFailureStage = 'download' | 'parse' | 'policy' | 'save' | 'verify'

export interface PluginUpdateSuccessResult {
    ok: true
    version: string
}

export interface PluginUpdateFailureResult {
    ok: false
    stage: PluginUpdateFailureStage
    /** Short machine-readable reason, e.g. `http-404`, `name-changed`, `pagefold-blocked`. */
    code: string
    /**
     * Diagnostic text for the console only. Never put plugin source, tokens,
     * or other secrets in here — this is allowed to reach the browser
     * console verbatim.
     */
    detail?: string
}

export type PluginUpdateResult = PluginUpdateSuccessResult | PluginUpdateFailureResult

/**
 * Thrown by an `importer` implementation (i.e. `importPlugin`) to report
 * exactly why an update install was rejected. Rejections carry a stage/code
 * pair instead of collapsing into a warn-and-return, so `runPluginUpdate` can
 * surface the real cause instead of a generic failure.
 */
export class PluginUpdateRejection extends Error {
    readonly stage: PluginUpdateFailureStage
    readonly code: string
    readonly detail?: string

    constructor(stage: PluginUpdateFailureStage, code: string, detail?: string) {
        super(`plugin update rejected [${stage}/${code}]${detail ? `: ${detail}` : ''}`)
        this.name = 'PluginUpdateRejection'
        this.stage = stage
        this.code = code
        this.detail = detail
    }
}

export interface PluginUpdateDependencies {
    /** Downloads the update source. Transport policy (proxy-awareness, headers, caching) is the caller's responsibility. */
    fetcher: (url: string) => Promise<Response>
    /** Installs `source`. Must reject with a `PluginUpdateRejection` to report a specific cause. */
    importer: (source: string, target: PluginUpdateTarget) => Promise<unknown>
    readInstalled: (name: string) => InstalledPluginSnapshot | undefined
}

export interface InstalledPluginUpdateActionDependencies {
    update: (plugin: PluginUpdateTarget) => Promise<PluginUpdateResult>
    reportSuccess: (result: PluginUpdateSuccessResult) => void
    reportFailure: (result: PluginUpdateFailureResult) => void
}

// This is the action invoked by the installed-plugin row's `+` control. Keep
// reporting behind the awaited update so a duplicate/no-op import cannot look
// like a completed installation.
export async function runInstalledPluginUpdateAction(
    plugin: PluginUpdateTarget,
    dependencies: InstalledPluginUpdateActionDependencies,
): Promise<PluginUpdateResult> {
    try {
        const result = await dependencies.update(plugin)
        if (result.ok === true) {
            dependencies.reportSuccess(result)
            return result
        }
        const failure: PluginUpdateFailureResult = result
        // Detail is diagnostic text only (see PluginUpdateFailureResult) and
        // is safe to log; the UI only ever shows the generic, localized
        // failure message.
        console.error(`Plugin update failed for "${plugin.name}" [${failure.stage}/${failure.code}]`, failure.detail ?? '')
        dependencies.reportFailure(failure)
        return failure
    } catch (error) {
        console.error('Failed to install plugin update:', error)
        const failure: PluginUpdateFailureResult = {
            ok: false,
            stage: 'verify',
            code: 'unexpected-exception',
            detail: error instanceof Error ? error.message : String(error),
        }
        dependencies.reportFailure(failure)
        return failure
    }
}

const declaredVersionPattern = /\/\/@version\s+([^\s]+)/

/** Reads the `//@version` metadata line out of downloaded plugin source. */
export function parseDeclaredPluginVersion(source: string): string | undefined {
    return source.match(declaredVersionPattern)?.[1]?.trim()
}

function compareVersionStrings(a: string, b: string): 0 | 1 | -1 {
    const aParts = a.split('.').map(Number)
    const bParts = b.split('.').map(Number)
    const len = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < len; i++) {
        const av = aParts[i] || 0
        const bv = bParts[i] || 0
        if (av > bv) return 1
        if (av < bv) return -1
    }
    return 0
}

export async function runPluginUpdate(
    plugin: PluginUpdateTarget,
    dependencies: PluginUpdateDependencies,
): Promise<PluginUpdateResult> {
    if (!plugin.updateURL) {
        return { ok: false, stage: 'download', code: 'missing-update-url' }
    }

    let response: Response
    try {
        response = await dependencies.fetcher(plugin.updateURL)
    } catch (error) {
        // A thrown fetch means the request never got a server response at
        // all: DNS/connection failure, timeout, or a CORS rejection the
        // proxy-aware fetcher could not recover from.
        return {
            ok: false,
            stage: 'download',
            code: 'network-error',
            detail: error instanceof Error ? error.message : String(error),
        }
    }

    if (!response.ok) {
        return {
            ok: false,
            stage: 'download',
            code: `http-${response.status}`,
            detail: `HTTP ${response.status}`,
        }
    }

    let source: string
    try {
        source = await response.text()
    } catch (error) {
        return {
            ok: false,
            stage: 'download',
            code: 'body-read-failed',
            detail: error instanceof Error ? error.message : String(error),
        }
    }

    const declaredVersion = parseDeclaredPluginVersion(source)
    if (!declaredVersion) {
        return { ok: false, stage: 'parse', code: 'version-missing-in-download' }
    }

    const previous = dependencies.readInstalled(plugin.name)

    try {
        await dependencies.importer(source, plugin)
    } catch (error) {
        if (error instanceof PluginUpdateRejection) {
            return { ok: false, stage: error.stage, code: error.code, detail: error.detail }
        }
        // The importer threw something we don't recognize (a bug, or a
        // storage/save exception that wasn't wrapped). Treat it as an
        // unclassified save failure rather than silently losing the cause.
        return {
            ok: false,
            stage: 'save',
            code: 'importer-threw',
            detail: error instanceof Error ? error.message : String(error),
        }
    }

    const installed = dependencies.readInstalled(plugin.name)
    if (!installed) {
        return { ok: false, stage: 'verify', code: 'not-installed-after-import' }
    }

    if (installed.updateURL !== plugin.updateURL) {
        return { ok: false, stage: 'verify', code: 'update-url-mismatch' }
    }

    const noChange = !!previous
        && previous.script === installed.script
        && previous.versionOfPlugin === installed.versionOfPlugin
    if (noChange) {
        // The importer resolved without rejecting, but nothing actually
        // changed (e.g. the downloaded source was byte-identical to what was
        // already installed). Don't report this as a completed installation.
        return { ok: false, stage: 'verify', code: 'no-change-detected' }
    }

    // Intentionally NOT an exact string match against the downloaded source:
    // legitimate transforms (TypeScript compilation, whitespace/newline
    // normalization on save) change the stored script without being
    // tampering. Verify identity via name/version/updateURL instead.
    if (installed.versionOfPlugin && compareVersionStrings(installed.versionOfPlugin, declaredVersion) !== 0) {
        return {
            ok: false,
            stage: 'verify',
            code: 'version-mismatch',
            detail: `expected ${declaredVersion}, installed ${installed.versionOfPlugin}`,
        }
    }

    return { ok: true, version: installed.versionOfPlugin ?? declaredVersion }
}
