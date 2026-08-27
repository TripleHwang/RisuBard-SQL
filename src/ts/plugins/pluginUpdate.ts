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
    /**
     * Set when the upstream source legitimately moved itself to a new
     * `//@update-url`. The install is accepted (see the verification notes in
     * `runPluginUpdate`), but the user is told the update source changed
     * because from now on this plugin is fetched from somewhere else.
     */
    updateURLChanged?: { from: string, to: string }
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

// Anchored at the START OF A LINE, unlike the original unanchored pattern: an
// unanchored `\/\/@version\s+(\S+)` also matches the tail of an unrelated line
// (a commented-out example, a string inside the plugin body).
const declaredVersionPattern = /^\/\/@version[ \t]+([^\s]+)[ \t]*$/m
const declaredUpdateURLPattern = /^\/\/@update-url[ \t]+([^\s]+)[ \t]*$/m
// Same line, but the match must be TERMINATED by a real newline. Used for the
// update CHECK, which reads only the first few hundred bytes of the file (a
// Range request) and therefore can see a line cut in half: without this,
// a truncated `//@version 1.2.3` matched as `1.2`, which either hides a real
// update or puts a bogus update badge up.
const terminatedVersionPattern = /^\/\/@version[ \t]+([^\s]+)[ \t]*\r?\n/m

/** Reads the `//@version` metadata line out of a COMPLETE plugin source. */
export function parseDeclaredPluginVersion(source: string): string | undefined {
    return source.match(declaredVersionPattern)?.[1]?.trim()
}

/**
 * Reads the `//@version` line out of a possibly TRUNCATED read (the ranged
 * update probe). Returns undefined unless the line is complete, so the caller
 * can retry with a full GET instead of trusting half a version token.
 */
export function parseDeclaredPluginVersionFromPartial(source: string): string | undefined {
    return source.match(terminatedVersionPattern)?.[1]?.trim()
}

/** Reads the `//@update-url` metadata line out of a COMPLETE plugin source. */
export function parseDeclaredPluginUpdateURL(source: string): string | undefined {
    return source.match(declaredUpdateURLPattern)?.[1]?.trim()
}

interface ParsedVersion {
    release: number[]
    /** Everything after the first `-`; empty means "not a prerelease". */
    prerelease: string
}

function parseVersion(value: string): ParsedVersion {
    // Strip a leading `v`/`V` ("v1.2.3" is an extremely common tag form and
    // used to collapse to 0.2.3 because Number('v1') is NaN) and any build
    // metadata, which never participates in precedence.
    const cleaned = value.trim().replace(/^[vV](?=\d)/, '').split('+')[0]
    const dashAt = cleaned.indexOf('-')
    const releasePart = dashAt === -1 ? cleaned : cleaned.slice(0, dashAt)
    const prerelease = dashAt === -1 ? '' : cleaned.slice(dashAt + 1)
    const release = releasePart.split('.').map((part) => {
        // Take the leading digits only, so "3beta" still counts as 3 instead
        // of silently becoming 0 and dragging the whole comparison down.
        const digits = /^\d+/.exec(part.trim())?.[0]
        const parsed = digits === undefined ? Number.NaN : Number.parseInt(digits, 10)
        return Number.isFinite(parsed) ? parsed : 0
    })
    return { release, prerelease }
}

/**
 * Compares two plugin version strings. Tolerates a `v` prefix, build metadata
 * and prerelease tags; a prerelease sorts BELOW the same release version
 * (1.2.3-beta < 1.2.3), matching semver precedence, so a prerelease upstream
 * build never looks like an upgrade over the matching stable release.
 */
export function comparePluginVersions(a: string, b: string): 0 | 1 | -1 {
    const left = parseVersion(a)
    const right = parseVersion(b)
    const len = Math.max(left.release.length, right.release.length)
    for (let i = 0; i < len; i++) {
        const av = left.release[i] ?? 0
        const bv = right.release[i] ?? 0
        if (av > bv) return 1
        if (av < bv) return -1
    }
    if (left.prerelease === right.prerelease) return 0
    if (left.prerelease === '') return 1
    if (right.prerelease === '') return -1
    return left.prerelease > right.prerelease ? 1 : -1
}

const compareVersionStrings = comparePluginVersions

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
        // The fetcher can refuse a URL outright (see the transport's
        // https/private-host guard); that carries its own stage/code and must
        // not be flattened into a generic network error.
        if (error instanceof PluginUpdateRejection) {
            return { ok: false, stage: error.stage, code: error.code, detail: error.detail }
        }
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

    // What this check is actually for: making sure the row we just wrote still
    // describes THE THING WE DOWNLOADED, and did not get pointed at some third
    // URL by the install. It is NOT a "the updateURL must never change" rule --
    // upstream is allowed to move its own source, and `mergePluginUpdateUserState`
    // deliberately spreads the downloaded metadata, so after a legitimate move
    // the row already holds the NEW url. Comparing it against the url we
    // started from therefore failed every genuine relocation ("the version DID
    // change" -- the install had succeeded and been saved), and the retry then
    // came back as verify/no-change-detected.
    //
    // "The download installs itself as a DIFFERENT plugin" -- the case worth
    // blocking -- is already caught upstream by policy/name-changed, which
    // refuses any update whose `//@name` differs from the row being updated.
    // So a new updateURL is accepted only when the downloaded source is the one
    // that declared it; anything else still fails as a mismatch.
    const declaredUpdateURL = parseDeclaredPluginUpdateURL(source)
    const updateURLUnchanged = installed.updateURL === plugin.updateURL
    const updateURLMovedByUpstream = !!declaredUpdateURL && installed.updateURL === declaredUpdateURL
    if (!updateURLUnchanged && !updateURLMovedByUpstream) {
        return {
            ok: false,
            stage: 'verify',
            code: 'update-url-mismatch',
            detail: declaredUpdateURL
                ? `downloaded source declares ${declaredUpdateURL}, row holds ${installed.updateURL ?? '(none)'}`
                : `downloaded source declares no update URL, row holds ${installed.updateURL ?? '(none)'}`,
        }
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

    const success: PluginUpdateSuccessResult = {
        ok: true,
        version: installed.versionOfPlugin ?? declaredVersion,
    }
    if (!updateURLUnchanged && installed.updateURL) {
        // Accepted, but the plugin is fetched from somewhere else from now on.
        // That is exactly the kind of change a user should hear about rather
        // than discover later, so it rides back on the success result.
        success.updateURLChanged = { from: plugin.updateURL, to: installed.updateURL }
    }
    return success
}
