'use strict';

/**
 * Validation boundary for an update manifest before any archive is downloaded.
 *
 * This module deliberately has no I/O.  Callers must obtain the manifest from
 * their configured channel, then pass the parsed JSON and their local runtime
 * identity here. A valid result only authorizes downloading the returned
 * artifact. Callers still verify the archive hash after download; manifest
 * authenticity is inherited from the configured repository and HTTPS.
 */

const DEFAULT_MAX_ARTIFACT_SIZE = 2 * 1024 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseUpdateVersion(value) {
    const normalized = String(value || '').trim();
    const semantic = normalized.replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
    if (semantic) {
        return {
            kind: 'semver',
            normalized: semantic[1] + (semantic[2] ? `-${semantic[2]}` : ''),
            parts: semantic[1].split('.').map(Number),
            prerelease: semantic[2] || '',
        };
    }

    const build = normalized.match(/^b(\d+)$/i);
    if (build) return { kind: 'build', normalized: `b${build[1]}`, build: Number(build[1]) };
    return null;
}

function compareUpdateVersions(left, right) {
    const a = parseUpdateVersion(left);
    const b = parseUpdateVersion(right);
    if (!a || !b || a.kind !== b.kind) return null;

    if (a.kind === 'build') return Math.sign(a.build - b.build);

    const length = Math.max(a.parts.length, b.parts.length);
    for (let i = 0; i < length; i += 1) {
        const difference = (a.parts[i] || 0) - (b.parts[i] || 0);
        if (difference !== 0) return Math.sign(difference);
    }
    if (a.prerelease === b.prerelease) return 0;
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function normalizeAllowedRepositories(repositories) {
    if (!Array.isArray(repositories) || repositories.length === 0) return [];
    return repositories
        .filter(value => typeof value === 'string' && REPOSITORY_RE.test(value))
        .map(value => value.toLowerCase());
}

/** Only direct, immutable GitHub Release download URLs are acceptable. */
function isAllowedGitHubReleaseUrl(value, allowedRepositories) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
    if (url.hostname.toLowerCase() !== 'github.com') return false;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') return false;
    let filename;
    try { filename = decodeURIComponent(parts[5]); } catch { return false; }
    if (!filename || filename === '.' || filename === '..' || /[\\/\0]/.test(filename)) return false;
    const repository = `${parts[0]}/${parts[1]}`.toLowerCase();
    return normalizeAllowedRepositories(allowedRepositories).includes(repository);
}

function invalid(reason) { return { valid: false, reason }; }

/**
 * @param {unknown} manifest parsed manifest JSON
 * @param {{productId:string, channel:string, currentVersion:string, platform:string, arch:string, allowedGithubRepositories:string[], maxArtifactSize?:number}} runtime
 * @returns {{valid:true, manifest:object, artifact:object}|{valid:false, reason:string}}
 */
function validateUpdateManifest(manifest, runtime) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid('Manifest must be an object');
    if (!runtime || typeof runtime !== 'object') return invalid('Runtime identity is required');
    const expected = ['productId', 'channel', 'currentVersion', 'platform', 'arch'];
    for (const key of expected) {
        if (typeof runtime[key] !== 'string' || !runtime[key].trim()) return invalid(`Runtime ${key} is required`);
    }
    if (manifest.schemaVersion !== 1) return invalid('Unsupported manifest schema version');
    if (manifest.productId !== runtime.productId) return invalid('Manifest productId does not match this installation');
    if (manifest.channel !== runtime.channel) return invalid('Manifest channel does not match this installation');
    if (!parseUpdateVersion(manifest.version)) return invalid('Manifest version is invalid');
    if (!parseUpdateVersion(runtime.currentVersion)) return invalid('Current version is invalid');

    const versionOrder = compareUpdateVersions(manifest.version, runtime.currentVersion);
    if (versionOrder === null) return invalid('Manifest and current versions use incompatible formats');
    if (versionOrder <= 0) return invalid('Manifest does not upgrade the current version');

    if (manifest.minSupportedVersion !== undefined) {
        if (!parseUpdateVersion(manifest.minSupportedVersion)) return invalid('Manifest minSupportedVersion is invalid');
        const supportOrder = compareUpdateVersions(runtime.currentVersion, manifest.minSupportedVersion);
        if (supportOrder === null) return invalid('minSupportedVersion format is incompatible with the current version');
        if (supportOrder < 0) return invalid('Current version is below the manifest minimum supported version');
    }

    if (!Array.isArray(manifest.artifacts)) return invalid('Manifest artifacts must be an array');
    const artifact = manifest.artifacts.find(candidate => candidate
        && typeof candidate === 'object'
        && candidate.platform === runtime.platform
        && candidate.arch === runtime.arch);
    if (!artifact) return invalid('No artifact matches this platform and architecture');
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) return invalid('Artifact size must be a positive safe integer');
    const maxSize = Number.isSafeInteger(runtime.maxArtifactSize) && runtime.maxArtifactSize > 0
        ? runtime.maxArtifactSize : DEFAULT_MAX_ARTIFACT_SIZE;
    if (artifact.size > maxSize) return invalid('Artifact exceeds the maximum allowed size');
    if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) return invalid('Artifact sha256 is invalid');
    if (!isAllowedGitHubReleaseUrl(artifact.url, runtime.allowedGithubRepositories)) {
        return invalid('Artifact URL is not an allowed HTTPS GitHub Release URL');
    }

    return {
        valid: true,
        manifest: { ...manifest, version: parseUpdateVersion(manifest.version).normalized },
        artifact: { ...artifact, sha256: artifact.sha256.toLowerCase() },
    };
}

module.exports = {
    DEFAULT_MAX_ARTIFACT_SIZE,
    compareUpdateVersions,
    isAllowedGitHubReleaseUrl,
    parseUpdateVersion,
    validateUpdateManifest,
};
