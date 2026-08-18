'use strict';

function parseVersion(value) {
    const normalized = String(value || '').trim().replace(/^v/i, '');
    const match = normalized.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
        normalized,
        parts: match[1].split('.').map(Number),
        prerelease: match[2] || '',
    };
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;

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

function releaseToUpdateInfo(release, currentVersion) {
    const latest = parseVersion(release?.tag_name);
    const current = parseVersion(currentVersion);
    if (!latest || !current) return null;

    const hasUpdate = compareVersions(latest.normalized, current.normalized) > 0;
    return {
        currentVersion: current.normalized,
        latestVersion: latest.normalized,
        hasUpdate,
        severity: hasUpdate ? 'optional' : 'none',
        releaseUrl: release.html_url || '',
        releaseName: release.name || release.tag_name || '',
        publishedAt: release.published_at || '',
        manualOnly: false,
    };
}

module.exports = { compareVersions, releaseToUpdateInfo };
