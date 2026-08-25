import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function generateUpdateManifest({
    directory,
    tag,
    repository,
    artifactPrefix = 'RisuVault',
    productId = 'risuvault',
    channel,
}) {
    if (!/^v\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`)
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid repository: ${repository}`)
    const version = tag.slice(1)
    const resolvedChannel = channel || (version.includes('-') ? 'beta' : 'stable')
    const escapedPrefix = artifactPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const filePattern = new RegExp(`^${escapedPrefix}-v${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(win|linux|macos)-(x64|arm64)\\.(zip|tar\\.gz)$`)
    const artifacts = []

    for (const filename of (await readdir(directory)).sort()) {
        const match = filename.match(filePattern)
        if (!match) continue
        const filePath = path.join(directory, filename)
        const [contents, metadata] = await Promise.all([readFile(filePath), stat(filePath)])
        artifacts.push({
            platform: match[1],
            arch: match[2],
            kind: 'portable',
            url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(filename)}`,
            size: metadata.size,
            sha256: createHash('sha256').update(contents).digest('hex'),
        })
    }
    if (artifacts.length === 0) throw new Error('No portable release artifacts found')

    return {
        schemaVersion: 1,
        productId,
        channel: resolvedChannel,
        version,
        publishedAt: new Date().toISOString(),
        artifacts,
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [directory = '.', tag, repository] = process.argv.slice(2)
    const manifest = await generateUpdateManifest({ directory, tag, repository })
    await writeFile(path.join(directory, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
