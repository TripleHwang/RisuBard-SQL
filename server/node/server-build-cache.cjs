const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const BUILD_INPUT_DIRECTORIES = ['src', 'public'];
const BUILD_INPUT_FILES = [
    'index.html',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.ts',
    'server/node/risubard-memory-analysis.ts',
    'server/node/risubard-memory-writer.ts',
];

function hasNewerFile(directory, outputModifiedAt) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (hasNewerFile(entryPath, outputModifiedAt)) return true;
        } else if (entry.isFile() && statSync(entryPath).mtimeMs > outputModifiedAt) {
            return true;
        }
    }
    return false;
}

function isBuildRequired(rootDir) {
    try {
        const outputModifiedAt = statSync(
            path.join(rootDir, 'dist', 'index.html')
        ).mtimeMs;

        for (const filename of BUILD_INPUT_FILES) {
            if (statSync(path.join(rootDir, filename)).mtimeMs > outputModifiedAt) {
                return true;
            }
        }

        return BUILD_INPUT_DIRECTORIES.some((directory) =>
            hasNewerFile(path.join(rootDir, directory), outputModifiedAt)
        );
    } catch {
        return true;
    }
}

if (require.main === module) {
    process.exitCode = isBuildRequired(process.cwd()) ? 1 : 0;
}

module.exports = { isBuildRequired };
