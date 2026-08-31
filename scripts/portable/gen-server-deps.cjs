/**
 * Generates a minimal package.json containing only the packages the Node
 * server actually loads at runtime, with versions pinned to pnpm-lock.yaml.
 *
 * Ported from PocketRisu (https://github.com/PocketRisu/PocketRisu),
 * scripts/portable/gen-server-deps.cjs, which is itself a fork of RisuAI
 * (https://github.com/kwaroran/RisuAI). Both that project and this one are
 * licensed GPL-3.0-only; this adaptation stays under GPL-3.0-only.
 *
 * Changes from the PocketRisu original, all forced by this repo's server:
 *   - server/node/risubard-memory-runtime.cjs calls require('sucrase/register/ts')
 *     and then requires .ts modules directly, so the graph continues through
 *     TypeScript source. The scan therefore also parses ESM `import ... from`
 *     and `export ... from` declarations, not just require()/import() calls.
 *   - Relative specifiers in that TypeScript are extensionless, so resolution
 *     tries .ts/.cjs/.js/.mjs and index files rather than requiring an
 *     explicit extension.
 *   - `?raw` asset specifiers (Vite-style, used for the bundled SKILL.md
 *     prompts) are recorded and checked to exist, but not parsed as code.
 *   - Any resolved file under src/ (the Svelte frontend) other than the
 *     server-shared src/ts/risubard/ tree is a hard error: the portable ships
 *     a prebuilt dist/, so a frontend module reaching the server graph means
 *     the split is wrong, not that the package list should grow.
 *   - devDependencies are rejected explicitly: the portable installs with
 *     --prod, so a server require landing on a devDependency would produce a
 *     package that boots in CI and fails in the wild.
 *
 * Usage: node gen-server-deps.cjs <appRoot> <outDir>
 *   appRoot — directory containing server/, pnpm-lock.yaml, package.json
 *             (scripts/updater.cjs is included as an entry when present)
 *   outDir  — created if missing; package.json is written there
 *
 * server/hono/ is deliberately not an entry point: it is a self-contained
 * alternate server with its own package.json and pnpm-lock.yaml, its
 * dependencies are not in the root manifest, and neither the portable
 * launchers nor the Docker image ever execute it. It ships as inert source.
 *
 * The canonical output lives at scripts/portable/server-deps/ (package.json +
 * pnpm-lock.yaml, both committed). CI regenerates and compares against the
 * committed package.json, then installs with --frozen-lockfile, so builds stay
 * fully reproducible down to transitive versions. When server dependencies
 * change, regenerate from the repo root:
 *
 *   node scripts/portable/gen-server-deps.cjs . scripts/portable/server-deps
 *   pnpm --dir scripts/portable/server-deps install --prod --lockfile-only --ignore-workspace
 *
 * Known limitation: the scan is regex-based, so a require()/import() literal
 * inside a block comment or template string would be picked up too. That fails
 * loudly (unknown package -> generation error; builtin -> filtered), never
 * silently.
 */

const fs = require('fs');
const path = require('path');
const { builtinModules, isBuiltin } = require('module');

const [appRoot, outDir] = process.argv.slice(2);
if (!appRoot || !outDir) {
    console.error('Usage: node gen-server-deps.cjs <appRoot> <outDir>');
    process.exit(1);
}

const BUILTINS = new Set(builtinModules);
const ENTRIES = ['server/node/server.cjs', 'scripts/updater.cjs'];
const RESOLVE_EXTENSIONS = ['.cjs', '.ts', '.js', '.mjs', '.mts', '.json'];

// Frontend source that the server is nonetheless allowed to load through
// sucrase. Everything else under src/ is bundled into dist/ and must never
// appear in the server's require graph.
const SHARED_SOURCE_PREFIXES = [
    'src/ts/risubard/',
    'packages/risubard-core/',
    'server/',
    'scripts/',
];

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function packageName(spec) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Resolve a relative specifier the way Node + sucrase/register do: exact path
// first, then each candidate extension, then index files inside a directory.
function resolveRelative(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [base];
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of RESOLVE_EXTENSIONS) {
        candidates.push(path.join(base, 'index' + ext));
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

// Walk the require()/import() graph, collecting external package names.
// Only static string-literal specifiers are supported; a non-literal argument
// is a hard error so a future refactor cannot silently escape the scan.
function collectExternals(entryFiles, rootDir) {
    const externals = new Map(); // package name -> [importer descriptions]
    const visited = new Set();
    const assets = new Set();
    const queue = entryFiles.slice();
    while (queue.length > 0) {
        const file = queue.pop();
        if (visited.has(file)) continue;
        visited.add(file);

        const relative = toPosix(path.relative(rootDir, file));
        if (!SHARED_SOURCE_PREFIXES.some((p) => relative.startsWith(p))) {
            console.error(
                `Server graph reaches '${relative}', which is outside the`
                + ' server-shared source tree.'
            );
            console.error(
                'The portable ships a prebuilt dist/; frontend modules must'
                + ' not be loadable from the server.'
            );
            process.exit(1);
        }

        const src = fs.readFileSync(file, 'utf-8');
        // Strip line comments so commented-out requires are ignored.
        const code = src.replace(/^\s*\/\/.*$/gm, '');
        const dynamic = code.match(/(?:require|import)\s*\(\s*[^'")\s]/);
        if (dynamic) {
            console.error(
                `Non-literal require()/import() in ${relative}: ${dynamic[0]}...`
            );
            console.error(
                'Add the target package to the scan manually or make the'
                + ' specifier static.'
            );
            process.exit(1);
        }

        const specifiers = [];
        // require('x') / import('x')
        for (
            const m of code.matchAll(
                /(?:require|import)\s*\(\s*'([^']+)'\s*\)|(?:require|import)\s*\(\s*"([^"]+)"\s*\)/g
            )
        ) {
            specifiers.push(m[1] ?? m[2]);
        }
        // ESM `import ... from 'x'`, `export ... from 'x'`, bare `import 'x'`.
        // Needed because sucrase lets the server require .ts modules directly.
        for (
            const m of code.matchAll(
                /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/g
            )
        ) {
            specifiers.push(m[1]);
        }

        for (const raw of specifiers) {
            // Vite-style asset queries (?raw) address a real file but are not code.
            const queryIndex = raw.indexOf('?');
            const spec = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
            const isAsset = queryIndex !== -1;

            if (spec.startsWith('.')) {
                const resolved = resolveRelative(file, spec);
                if (!resolved) {
                    console.error(
                        `Unresolvable relative import '${raw}' in ${relative}`
                    );
                    process.exit(1);
                }
                if (isAsset) {
                    assets.add(toPosix(path.relative(rootDir, resolved)));
                } else {
                    queue.push(resolved);
                }
                continue;
            }

            // isBuiltin() covers the node:-only builtins that are absent from
            // builtinModules, notably node:sqlite — this server's SQLite
            // engine is Node's own, so no npm driver appears in the closure.
            if (isBuiltin(spec)) continue;
            const name = spec.startsWith('node:') ? spec.slice(5) : spec;
            const pkg = packageName(name);
            if (BUILTINS.has(pkg)) continue;
            if (!externals.has(pkg)) externals.set(pkg, new Set());
            externals.get(pkg).add(`${relative} -> ${raw}`);
        }
    }
    return { externals, visited, assets };
}

// Extract exact resolved versions of the root importer's dependencies from
// pnpm-lock.yaml (lockfile v9 layout). Line-based on purpose: no YAML parser
// available here, and the importers section layout is stable.
function readLockedVersions(lockfilePath) {
    const lines = fs.readFileSync(lockfilePath, 'utf-8').split('\n');
    const dependencies = {};
    const devDependencies = {};
    let inRootImporter = false;
    let section = null;
    let currentDep = null;
    for (const line of lines) {
        if (/^importers:/.test(line)) { inRootImporter = false; continue; }
        if (/^ {2}\.:/.test(line)) { inRootImporter = true; continue; }
        if (/^ {2}\S/.test(line)) { inRootImporter = false; continue; }
        if (!inRootImporter) continue;
        if (/^ {4}dependencies:/.test(line)) { section = dependencies; continue; }
        if (/^ {4}devDependencies:/.test(line)) {
            section = devDependencies;
            continue;
        }
        if (/^ {4}\S/.test(line)) { section = null; continue; }
        if (!section) continue;
        const depMatch = line.match(/^ {6}(?:'([^']+)'|([^\s':][^':]*)):/);
        if (depMatch) { currentDep = depMatch[1] ?? depMatch[2]; continue; }
        const verMatch = line.match(/^ {8}version: ([^\s(]+)/);
        if (verMatch && currentDep) {
            section[currentDep] = verMatch[1];
            currentDep = null;
        }
    }
    return { dependencies, devDependencies };
}

// This repo declares the pnpm build-script allowlist in pnpm-workspace.yaml
// (`allowBuilds:`), not in package.json. The generated manifest is installed
// standalone with --ignore-workspace, so the allowlist has to travel with it
// as package.json "pnpm".onlyBuiltDependencies — otherwise pnpm 10 blocks
// build scripts and msgpackr's native accelerator never gets built.
function readAllowedBuilds(workspacePath) {
    if (!fs.existsSync(workspacePath)) return null;
    const lines = fs.readFileSync(workspacePath, 'utf-8').split('\n');
    const allowed = [];
    let inAllowBuilds = false;
    for (const line of lines) {
        if (/^allowBuilds:/.test(line)) { inAllowBuilds = true; continue; }
        if (/^\S/.test(line)) { inAllowBuilds = false; continue; }
        if (!inAllowBuilds) continue;
        const m = line.match(/^ {2}(?:'([^']+)'|"([^"]+)"|([^\s:]+))\s*:\s*true\s*$/);
        if (m) allowed.push(m[1] ?? m[2] ?? m[3]);
    }
    return allowed.length > 0 ? allowed.sort() : null;
}

const rootDir = path.resolve(appRoot);
const entryFiles = [];
for (const entry of ENTRIES) {
    const p = path.join(rootDir, entry);
    if (fs.existsSync(p)) entryFiles.push(path.resolve(p));
}
if (entryFiles.length === 0) {
    console.error(
        `No entry files found under ${appRoot} (expected ${ENTRIES.join(', ')})`
    );
    process.exit(1);
}

const { externals, visited, assets } = collectExternals(entryFiles, rootDir);
const locked = readLockedVersions(path.join(rootDir, 'pnpm-lock.yaml'));
const appPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')
);
const allowedBuilds = readAllowedBuilds(
    path.join(rootDir, 'pnpm-workspace.yaml')
);

const dependencies = {};
for (const name of [...externals.keys()].sort()) {
    if (locked.devDependencies[name] && !locked.dependencies[name]) {
        console.error(
            `Server requires '${name}', but it is a devDependency.`
        );
        console.error(
            `  imported from: ${[...externals.get(name)].join(', ')}`
        );
        console.error(
            'The portable and the Docker image install with --prod, so this'
            + ' would be missing at runtime. Move it to "dependencies".'
        );
        process.exit(1);
    }
    if (!locked.dependencies[name]) {
        console.error(
            `Server requires '${name}' but it is not a dependency in`
            + " pnpm-lock.yaml's root importer."
        );
        console.error(
            `  imported from: ${[...externals.get(name)].join(', ')}`
        );
        console.error('Add it to package.json "dependencies" first.');
        process.exit(1);
    }
    dependencies[name] = locked.dependencies[name];
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify({
        name: 'risuvault-server-deps',
        // Fixed version: this file is committed, and tracking the app version
        // would churn it on every release for no benefit.
        version: '0.0.0',
        private: true,
        dependencies,
        // Mirrors the root pnpm-workspace.yaml allowBuilds list (falling back
        // to a package.json "pnpm" block if one ever appears). Without it
        // pnpm 10 blocks dependency build scripts, and packages with native
        // addons or postinstall steps arrive unbuilt.
        pnpm: allowedBuilds
            ? { onlyBuiltDependencies: allowedBuilds }
            : appPkg.pnpm,
    }, null, 2) + '\n'
);

console.log(`Scanned ${visited.size} server source files.`);
if (assets.size > 0) {
    console.log(`Bundled assets (?raw): ${[...assets].sort().join(', ')}`);
}
console.log(`Server runtime dependencies (${Object.keys(dependencies).length}):`);
for (const [name, version] of Object.entries(dependencies)) {
    console.log(`  ${name}@${version}`);
}
