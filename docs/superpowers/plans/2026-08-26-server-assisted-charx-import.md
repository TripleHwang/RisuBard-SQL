# Server-Assisted CharX Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import large CharX files in Node deployments without decompressing or Base64-encoding their assets in the Android browser, while preserving the existing browser-only fallback and character-finalization behavior.

**Architecture:** The browser streams a raw `Blob` to an authenticated NDJSON endpoint. A focused Node helper incrementally extracts metadata and stages assets to disk, then file-native KV publishes the content-addressed asset keys in one additive manifest commit. The server returns only card/module metadata and the asset map; existing client code remains the sole owner of module merge and character database mutation.

**Tech Stack:** Svelte 5/TypeScript, Node.js 22 CommonJS/Express, fflate streaming ZIP APIs, file-native content-addressed KV, XMLHttpRequest NDJSON, Vitest.

---

## File Map

- Modify `docs/superpowers/plans/2026-08-26-server-assisted-charx-import-design.md` — record the approved 256 MiB upload limit and exact existing card-v3 compatibility.
- Modify `server/node/file-kv.cjs` — add atomic additive publication from staged files.
- Modify `server/node/file-kv.test.ts` — prove additive and failure-atomic file publication.
- Create `server/node/charx-import.cjs` — own CharX ZIP validation, disk staging, hashing, limits, cleanup, and result construction.
- Create `server/node/charx-import.test.ts` — test extraction, limits, security, aborts, cleanup, and large-stream behavior.
- Create `server/node/charx-import-route.cjs` — own the testable authenticated HTTP/NDJSON lifecycle.
- Modify `server/node/server.cjs` — bypass body buffering and expose the authenticated NDJSON route.
- Create `server/node/charx-import-route.test.ts` — protect parser, auth/session/lock, response, and persistence wiring.
- Modify `server/node/import-parallelism.test.ts` — protect the no-full-buffer implementation contract.
- Modify `src/ts/storage/nodeStorage.ts` — define result/progress types and raw XHR transport.
- Modify `src/ts/storage/autoStorage.ts` — expose the Node transport through the storage facade.
- Create `src/ts/storage/nodeStorage.charx.test.ts` — verify raw body, auth/session headers, progress, result, and errors.
- Modify `src/ts/characterCards.ts` — choose the server path only in Node mode and feed its result into existing finalization.
- Modify `src/ts/characterCards.import.test.ts` — prove Node selection, non-Node fallback, no error fallback, module/assets, and `returnCharacter` semantics.
- Modify `package.json` — release the user-facing feature as `0.3.0`.

## Locked Contracts

```ts
export interface ServerCharXImportResult {
    card: CharacterCardV3
    moduleBase64: string | null
    assets: Record<string, string>
    excludedFiles: string[]
    warnings: string[]
}

export type ServerCharXImportProgress =
    | { phase: 'uploading'; loaded: number; total: number }
    | { phase: 'processing'; completed: number; total: number }
```

```js
const DEFAULT_CHARX_LIMITS = Object.freeze({
    compressedBytes: 256 * 1024 * 1024,
    decompressedBytes: 2 * 1024 * 1024 * 1024,
    entries: 10_000,
    cardBytes: 4 * 1024 * 1024,
    moduleBytes: 16 * 1024 * 1024,
    assetBytes: 50 * 1024 * 1024,
    queuedWriteBytes: 8 * 1024 * 1024,
    diskHeadroomBytes: 256 * 1024 * 1024,
})

async function importCharXStream(source, {
    stagingRoot,
    publishAssets,
    limits = DEFAULT_CHARX_LIMITS,
    expectedCompressedBytes = 0,
    getAvailableBytes,
    onProgress = () => {},
    signal,
}) {}
```

`publishAssets` receives `{ key, sourcePath }[]` only after the whole archive is valid. It maps accepted ZIP entries to `assets/<sha256>.png`. Node failures are shown to the user and never trigger `CharXImporter`; only `!isNodeServer` uses the browser path.

---

### Task 1: Add atomic additive staged-file publication

**Files:**
- Modify: `server/node/file-kv.test.ts`
- Modify: `server/node/file-kv.cjs`

- [ ] **Step 1: Write failing additive-publication tests**

Add tests that retain an existing asset, add two staged files, and verify all three keys after reopening the store. Add a second test with one valid and one missing source file and verify neither new key becomes visible. Add a third test using an injected manifest writer that throws after object preparation; both the live store and a reopened store must retain only the prior manifest:

```ts
it('adds staged files in one manifest commit without replacing existing assets', async () => {
    const dataRoot = root()
    const stagingRoot = root()
    const store = createFileKv({ dataRoot })
    store.kvSet('assets/existing.png', Buffer.from('existing'))
    const first = path.join(stagingRoot, 'first.bin')
    const second = path.join(stagingRoot, 'second.bin')
    fs.writeFileSync(first, 'first')
    fs.writeFileSync(second, 'second')

    await store.kvSetManyFromFilesAsync([
        { key: 'assets/first.png', sourcePath: first },
        { key: 'assets/second.png', sourcePath: second },
    ])

    const reopened = createFileKv({ dataRoot })
    expect(reopened.kvList('assets/')).toEqual([
        'assets/existing.png', 'assets/first.png', 'assets/second.png',
    ])
})
```

- [ ] **Step 2: Verify the new tests fail for the missing API**

Run:

```bash
pnpm exec vitest run --config vitest.config.server.ts server/node/file-kv.test.ts
```

Expected: FAIL with `store.kvSetManyFromFilesAsync is not a function`.

- [ ] **Step 3: Implement the minimal additive file-backed batch**

Use the existing private `prepareFileEntriesAsync`, prepare everything before copying the manifest, and export the method. Add a private `commitManifest(next)` that writes the candidate first and swaps the closure variable only after durable persistence succeeds. Use an optional `options.manifestWriter` test seam, defaulting to `atomicWriteJson`:

```js
async function kvSetManyFromFilesAsync(entries) {
    const prepared = await prepareFileEntriesAsync(entries)
    if (!entries.length) return
    const next = {
        schemaVersion: 1,
        updatedAt: Date.now(),
        entries: { ...manifest.entries },
    }
    for (const [key, entry] of prepared) next.entries[key] = entry
    commitManifest(next)
}
```

`commitManifest` must call the writer with `next`, then assign `manifest = next`.
Do not mutate `manifest.entries` before the write succeeds.

- [ ] **Step 4: Run the focused server test and check formatting**

Run the focused command from Step 2 and `git diff --check`.

Expected: all `file-kv.test.ts` tests pass and no whitespace errors.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/node/file-kv.cjs server/node/file-kv.test.ts
git commit -m "feat(storage): publish staged asset batches"
```

---

### Task 2: Build the bounded CharX extraction helper

**Files:**
- Create: `server/node/charx-import.cjs`
- Create: `server/node/charx-import.test.ts`

- [ ] **Step 1: Write the valid-archive tests**

Generate small archives in tests with `fflate.zipSync`. Cover card-only, card plus module, multiple assets, ignored extra JSON, duplicate-content deduplication, and progress. The first behavioral assertion must be:

```ts
const result = await importCharXStream(Readable.from(archive), {
    stagingRoot,
    publishAssets: async entries => published.push(...entries),
})

expect(result.card.spec).toBe('chara_card_v3')
expect(Buffer.from(result.moduleBase64!, 'base64')).toEqual(moduleBytes)
expect(result.assets['assets/avatar.png']).toBe(`assets/${avatarHash}.png`)
expect(published[0].sourcePath.startsWith(stagingRoot)).toBe(true)
```

`publishAssets` must read its source files during the callback so the test proves they exist until publication finishes.

- [ ] **Step 2: Verify valid-archive tests fail because the module is absent**

Run:

```bash
pnpm exec vitest run --config vitest.config.server.ts server/node/charx-import.test.ts
```

Expected: FAIL because `./charx-import.cjs` does not exist.

- [ ] **Step 3: Implement the streaming happy path**

Export exactly these public values:

```js
module.exports = {
    CharXImportError,
    DEFAULT_CHARX_LIMITS,
    importCharXStream,
}
```

Use `fflate.Unzip` plus `fflate.UnzipInflate`. Consume `source` with `for await`, count compressed bytes before each `unzip.push`, and await pending write-stream drains before reading the next source chunk. Store `card.json` and `module.risum` in bounded chunk arrays; write every asset to a random staging filename while updating a Node `crypto.createHash('sha256')` digest. Do not use `Buffer.concat` for the upload or for assets. `Buffer.concat` is allowed only for the bounded card/module metadata after its limit has been enforced.

- [ ] **Step 4: Write failing validation and exclusion tests**

Add one focused test per behavior:

- missing, duplicate, invalid JSON, and non-v3 `card.json` reject with `INVALID_CHARX`;
- malformed UTF-8 in `card.json` rejects through `TextDecoder('utf-8', { fatal: true })`;
- unsafe, duplicate-normalized, encrypted, and unsupported-compression entries reject;
- compressed bytes, total decompressed bytes, entry count, card size, and module size reject with `CHARX_LIMIT_EXCEEDED`;
- an asset above 50 MiB is drained, removed from staging, listed in `excludedFiles`, and does not prevent the valid card from returning;
- a truncated stream rejects and never calls `publishAssets`.

Use per-test limits such as 32 or 128 bytes so boundary tests stay fast. Entry names
are Unicode-NFC normalized and remain case-sensitive. Build encrypted-flag and
unsupported-method cases from handcrafted minimal ZIP bytes rather than claiming
`zipSync` can generate them.

- [ ] **Step 5: Run validation tests and observe the expected failures**

Run the Task 2 test command. Expected: the new invalid/limit cases currently succeed or return the wrong error.

- [ ] **Step 6: Implement incremental validation**

Add a typed error with stable code and status metadata:

```js
class CharXImportError extends Error {
    constructor(code, message, status = 400) {
        super(message)
        this.name = 'CharXImportError'
        this.code = code
        this.status = status
    }
}
```

Validate both advertised ZIP sizes and actual streamed decompressed bytes. ZIP names must never be joined to a disk path; generated UUID filenames are the only staging destinations. Reject `\0`, `\\`, leading `/`, drive prefixes, `.`/`..` components, and duplicate Unicode-NFC names while preserving case sensitivity. Ignore directory entries and non-card JSON entries. Require exactly one root `card.json` with fatal UTF-8 decoding, `spec === 'chara_card_v3'`, and at most one root `module.risum`.

- [ ] **Step 7: Write failing abort, cleanup, backpressure, and large-stream tests**

Test an already-aborted signal, abort during extraction, an injected staging-write failure, and an injected `publishAssets` failure. After each rejection, assert the helper-created staging directory is gone. Use a deliberately slow writable/drain boundary and assert source iteration does not run unbounded ahead. Generate a synthesized 130 MiB-class archive directly to a temporary file with `fflate.Zip` streaming writes, feed it with `fs.createReadStream`, and assert bounded read-ahead and successful import; do not materialize the archive with `zipSync` or `Buffer.concat`. Give this test an explicit timeout suitable for the server suite.

Inject a disk-capacity reader in tests. Before extraction, require conservative
headroom based on known `Content-Length`; before starting an entry with a declared
original size, re-check available bytes against that entry plus a fixed safety margin.
Before every staged write, including entries with unknown or incorrect advertised
sizes, require enough currently available space for the next chunk plus the fixed
headroom. Immediately before `publishAssets`, require available space for the complete
staged asset byte count plus headroom because the current file-KV object writer copies
before deleting sources. Cover preflight rejection, unknown-size incremental
rejection, publication-time low space, and an `ENOSPC` write failure.

- [ ] **Step 8: Implement cleanup and capacity control**

Wrap helper-owned staging in `try/finally`, terminate open unzip decoders on failure, destroy file streams, remove partial files, and recursively remove the unique helper directory. Check `signal.aborted` before input reads and in entry callbacks. Do not resolve until ZIP input is finalized, every opened entry is finalized, every staging stream is synced/closed, and `publishAssets` has completed.

Throttle `statfs` calls only by cached available-byte accounting: subtract every
successfully staged chunk from the last measured value and refresh before each new
entry and before publication. Never skip the incremental capacity comparison.

- [ ] **Step 9: Run Task 2 tests and server regression tests**

```bash
pnpm exec vitest run --config vitest.config.server.ts server/node/charx-import.test.ts server/node/file-kv.test.ts
```

Expected: PASS with no unhandled rejection or open-handle warning.

- [ ] **Step 10: Commit Task 2**

```bash
git add server/node/charx-import.cjs server/node/charx-import.test.ts
git commit -m "feat(server): stream CharX extraction"
```

---

### Task 3: Expose the authenticated Node import route

**Files:**
- Create: `server/node/charx-import-route.cjs`
- Modify: `server/node/server.cjs`
- Create: `server/node/charx-import-route.test.ts`
- Modify: `server/node/import-parallelism.test.ts`

- [ ] **Step 1: Write failing behavioral route tests**

Create an isolated Express app around a wished-for `createCharXImportHandler(deps)`.
Use real streamed HTTP requests and injected auth/session/import/publish functions to
prove:

- auth and active-session checks happen before the request body is consumed;
- wrong content type is 415, known oversize is 413, busy import is 409, disk shortage
  is 507, and invalid CharX is 400;
- the lock is released after success, validation error, disconnect, and publish error;
- streamed progress/done/error NDJSON is correctly framed and heartbeat-safe;
- disconnect aborts the helper; and
- response bodies never contain staging paths or stacks.

Keep these source assertions only as supplemental parser/wiring regressions:

```ts
expect(server).toContain("req.path === '/api/charx/import'")
expect(server).toContain("app.post('/api/charx/import'")
expect(server).toContain('kvSetManyFromFilesAsync')
expect(route).toContain('await checkAuth(req, res)')
expect(route).toContain('checkActiveSession(req, res)')
expect(server).not.toMatch(/charx[\s\S]{0,1500}Buffer\.concat\(chunks\)/i)
```

Also assert the route references `importInProgress`, accepts only `application/x-risu-charx`, uses the 256 MiB helper limit, disables timeouts, requests no response buffering, emits progress/done/error NDJSON, and restores its lock/timeout in `finally`.

- [ ] **Step 2: Run the route tests and verify they fail for the missing route**

```bash
pnpm exec vitest run --config vitest.config.server.ts server/node/charx-import-route.test.ts server/node/import-parallelism.test.ts
```

Expected: FAIL because `charx-import-route.cjs`, its factory, and the parser exclusion are absent.

- [ ] **Step 3: Implement the testable route factory**

Export:

```js
module.exports = { createCharXImportHandler }
```

The factory receives `checkAuth`, `checkActiveSession`, `beginImport`, `endImport`,
`importCharXStream`, `publishAssets`, `stagingRoot`, `getAvailableBytes`, `limits`,
`heartbeatMs`, and `logger`. It returns one Express async handler and owns the complete
timeout, abort, NDJSON, status mapping, and `finally` lifecycle. `beginImport()` returns
false when another backup/CharX import owns the shared lock.

- [ ] **Step 4: Wire the helper, KV publication, and parser exclusion**

Add imports/destructuring for `importCharXStream`, `DEFAULT_CHARX_LIMITS`, and `kvSetManyFromFilesAsync`. Update the raw-body middleware to skip both streaming routes:

```js
if (req.path === '/api/backup/import' || req.path === '/api/charx/import') return next()
```

The persistence callback must call `kvSetManyFromFilesAsync(entries)` and only return after the manifest commit succeeds.

- [ ] **Step 5: Implement the route lifecycle and protocol**

The route must:

1. authenticate and require the active writer session before reading the body;
2. reject concurrent imports with 409;
3. reject wrong content type with 415 and known oversize with 413;
4. tie an `AbortController` to `req.aborted`/premature close;
5. disable and later restore request timeouts;
6. emit `application/x-ndjson`, `no-cache, no-transform`, `x-accel-buffering: no`, heartbeat lines, throttled progress, then one `done` result;
7. map `CharXImportError.status/code` into pre-header JSON or post-header NDJSON error messages; and
8. release listeners, timer, controller, lock, and timeout in `finally`.

Pass numeric `Content-Length` as `expectedCompressedBytes` and a `statfs(savePath)`
capacity reader to the helper. Map filesystem `ENOSPC` failures to
`INSUFFICIENT_STORAGE` with HTTP 507; do not
return staging paths or stack traces to the browser.

Return the helper result inside `{"type":"done","result":...}` rather than mutating the character database on the server.

- [ ] **Step 6: Run route, extractor, and file-KV tests**

```bash
pnpm exec vitest run --config vitest.config.server.ts server/node/charx-import-route.test.ts server/node/import-parallelism.test.ts server/node/charx-import.test.ts server/node/file-kv.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add server/node/charx-import-route.cjs server/node/server.cjs server/node/charx-import-route.test.ts server/node/import-parallelism.test.ts
git commit -m "feat(server): add CharX import endpoint"
```

---

### Task 4: Add the authenticated raw-Blob client transport

**Files:**
- Modify: `src/ts/storage/nodeStorage.ts`
- Modify: `src/ts/storage/autoStorage.ts`
- Create: `src/ts/storage/nodeStorage.charx.test.ts`

- [ ] **Step 1: Write a fake-XHR transport test first**

The test must instantiate `NodeStorage`, stub `createAuth`, install a fake `XMLHttpRequest`, call `importCharX(blob, callback)`, and assert:

```ts
expect(xhr.method).toBe('POST')
expect(xhr.url).toBe('/api/charx/import')
expect(xhr.headers['content-type']).toBe('application/x-risu-charx')
expect(xhr.headers.accept).toBe('application/x-ndjson')
expect(xhr.headers['risu-auth']).toBe('test-auth')
expect(xhr.headers['x-session-id']).toBeTruthy()
expect(xhr.sentBody).toBe(blob)
expect(result.assets).toEqual({ 'assets/avatar.png': 'assets/hash.png' })
```

Feed fragmented progress and done lines through `responseText`; assert both upload and processing callbacks. Cover HTTP JSON errors, NDJSON error lines, malformed/unknown lines, missing final result, and network error.

Define the stale-server contract: HTTP 404 or 501 rejects with
`Server-assisted CharX import is unavailable. Update the RisuVault server and try again.`
Test this exact actionable message.

- [ ] **Step 2: Run the client transport test and verify the API is missing**

```bash
pnpm exec vitest run src/ts/storage/nodeStorage.charx.test.ts
```

Expected: FAIL because `NodeStorage.importCharX` does not exist.

- [ ] **Step 3: Add result/progress types and XHR implementation**

Add the locked types near other transport types. Model the method after `importBackup`, but send the original `Blob` directly and parse `done.result`:

```ts
async importCharX(file: Blob, onProgress?: (progress: ServerCharXImportProgress) => void): Promise<ServerCharXImportResult>
```

On `xhr.upload.onprogress`, emit `phase: 'uploading'`. After upload completion, convert server `progress` records to `phase: 'processing'`. On load, drain the final non-newline-terminated fragment before deciding whether a result exists. Never Base64-encode the uploaded file.

- [ ] **Step 4: Forward the capability through AutoStorage**

```ts
async importCharX(file: Blob, onProgress?: (progress: ServerCharXImportProgress) => void) {
    await this.Init()
    return this.realStorage.importCharX(file, onProgress)
}
```

Import the two transport types with `type` modifiers.

- [ ] **Step 5: Run focused client tests and type checking**

```bash
pnpm exec vitest run src/ts/storage/nodeStorage.charx.test.ts
pnpm check
```

Expected: PASS with zero Svelte/TypeScript errors.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/ts/storage/nodeStorage.ts src/ts/storage/autoStorage.ts src/ts/storage/nodeStorage.charx.test.ts
git commit -m "feat(client): upload CharX to Node server"
```

---

### Task 5: Select the Node path and reuse character finalization

**Files:**
- Modify: `src/ts/characterCards.import.test.ts`
- Modify: `src/ts/characterCards.ts`

- [ ] **Step 1: Refactor the existing test harness without changing production**

Mock `./platform` with a hoisted mutable `isNodeServer`, provide `forageStorage.importCharX`, count `CharXImporter` constructions, and return a valid v3 card. Preserve the existing delayed-archive completion test in non-Node mode.

- [ ] **Step 2: Write failing Node-selection tests**

Cover all of these separately:

- Node `.charx` with `File` sends the same file object and never constructs `CharXImporter`;
- Node `.charx` with `Uint8Array` wraps it in a `Blob` and uses the server;
- non-Node `.charx` uses the unchanged importer;
- Node server rejection propagates to the existing `importCharacter` UI boundary and
  does not invoke browser fallback;
- server module Base64 is passed through existing `readModule` and its trigger/regex/lorebook merge;
- server assets reach `importCharacterCardSpec` behavior and vault pinning;
- `returnCharacter: true` still returns the created character;
- `.jpg`/`.jpeg` behavior remains on the existing local path.

- [ ] **Step 3: Run the import test and observe Node cases fail**

```bash
pnpm exec vitest run src/ts/characterCards.import.test.ts
```

Expected: Node cases construct `CharXImporter` or never call `importCharX`.

- [ ] **Step 4: Implement one shared CharX finalization path**

Import `isNodeServer`. Extract only enough local variables to avoid duplicating card/module/finalization logic:

```ts
let cardData: string
let moduleData: Uint8Array | undefined
let assets: Record<string, string>

if (isNodeServer && f.name.toLowerCase().endsWith('.charx')) {
    if (f.data instanceof ReadableStream) throw new Error('Node CharX import requires a file or byte buffer')
    const blob = f.data instanceof Uint8Array ? new Blob([f.data]) : f.data
    const result = await forageStorage.importCharX(blob, updateServerCharXAlert)
    cardData = JSON.stringify(result.card)
    moduleData = result.moduleBase64 ? new Uint8Array(Buffer.from(result.moduleBase64, 'base64')) : undefined
    assets = result.assets
} else {
    const importer = new CharXImporter()
    importer.alertInfo = true
    await importer.parse(f.data)
    await importer.done()
    cardData = importer.cardData
    moduleData = importer.moduleData
    assets = importer.assets
}
```

The actual implementation must handle absent `cardData` before assigning it to a required string. Keep the current v3 validation, `readModule`, `importCharacterCardSpec`, `returnCharacter`, vault pinning, and result index in one shared tail. Use progress alert messages `Uploading CharX…`, `Processing CharX on server…`, and `Finalizing character…`. Report excluded files once after successful import.

Do not add a catch inside `importCharacterProcess`: transport errors must reject so
the existing `importCharacter` wrapper displays `alertError`. Add one wrapper-level
test by mocking `selectFileByDom`, and one direct-process test that asserts rejection;
both must prove `CharXImporter` was never constructed after a server failure.

- [ ] **Step 5: Run focused import and fallback tests**

```bash
pnpm exec vitest run src/ts/characterCards.import.test.ts src/ts/process/processzip.test.ts
```

Expected: PASS; the existing browser batching tests remain unchanged.

- [ ] **Step 6: Run client type checking and the nearby character-card suite**

```bash
pnpm check
pnpm exec vitest run src/ts/characterCards.test.ts src/ts/characterCards.import.test.ts src/ts/process/processzip.test.ts src/ts/storage/nodeStorage.charx.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/ts/characterCards.ts src/ts/characterCards.import.test.ts
git commit -m "feat(charx): use server import in Node mode"
```

---

### Task 6: Finalize documentation and release version

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the release version**

Change only the root package version:

```json
"version": "0.3.0"
```

Do not manually create a tag or release in this task.

- [ ] **Step 2: Run release-contract checks**

```bash
pnpm check:standalone-release
pnpm exec vitest run scripts/generate-update-manifest.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Commit Task 6**

```bash
git add package.json
git commit -m "chore(release): prepare v0.3.0"
```

---

### Task 7: Verify the complete feature before PR

**Files:**
- Verify only; modify production or tests only to resolve concrete failures.

- [ ] **Step 1: Run formatting and static checks**

```bash
git diff --check origin/main...HEAD
pnpm check
pnpm check:public-boundary
pnpm check:brand-boundary
pnpm check:theme-tokens
```

- [ ] **Step 2: Run build and complete test suites**

```bash
pnpm build
pnpm test
pnpm test:compat
pnpm check:standalone-release
```

Expected: every command exits 0. Known `ECONNREFUSED localhost:3000` diagnostic logging is acceptable only when the test command still exits 0.

- [ ] **Step 3: Audit scope and secrets**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only planned files changed, no generated build output, credentials, `.env`, `save/`, or test fixtures are tracked.

- [ ] **Step 4: Request final spec and code-quality reviews**

Review `origin/main...HEAD` against the design and this plan. Fix every Critical/Important issue, rerun the affected focused tests, and request re-review until approved.

---

### Task 8: Create PR, merge, and publish v0.3.0

**Files:**
- External Git/GitHub state only after Task 7 passes.

- [ ] **Step 1: Push the feature branch and create the PR**

```bash
git push -u origin feat/server-assisted-charx-import
gh pr create --repo TripleHwang/RisuVault --base main --head feat/server-assisted-charx-import
```

Use `.github/pull_request_template.md`. Include the Android renderer-OOM cause, raw server upload design, 256 MiB/2 GiB/50 MiB limits, non-Node fallback, verification commands, and no-migration impact.

- [ ] **Step 2: Wait for required PR checks**

```bash
gh pr checks <PR_NUMBER> --repo TripleHwang/RisuVault --watch
```

Do not merge until every required check passes. Diagnose and fix failures on the feature branch, push, and wait again.

- [ ] **Step 3: Merge through GitHub**

```bash
gh pr merge <PR_NUMBER> --repo TripleHwang/RisuVault --merge
```

Verify the PR reports `MERGED` and capture the merge commit SHA.

- [ ] **Step 4: Tag the merged main commit, not the feature head**

From a clean main checkout:

```bash
git fetch origin main --tags
git switch main
git pull --ff-only origin main
node -p "require('./package.json').version"
git ls-remote --exit-code --tags origin refs/tags/v0.3.0
git tag -a v0.3.0 -m "RisuVault v0.3.0"
git push origin v0.3.0
```

Expected: package version prints `0.3.0`; the pre-tag remote lookup finds no existing tag; the tag push triggers `.github/workflows/release.yml`.

- [ ] **Step 5: Monitor and publish the workflow-owned draft release**

Wait for `Create GitHub Release with Portable Packages` and related release workflows. Verify the draft contains `update-manifest.json` and the Windows x64, Linux x64/arm64, and macOS arm64 archives. Inspect autogenerated notes and artifact checks before publishing the existing draft. Do not run `gh release create`, because the workflow owns draft creation.
