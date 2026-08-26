# V0.3.1 Large Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Import up to a 3 GiB risum, large save-folder ZIPs, and large binary assets in Node mode without browser-size-proportional memory use, preserving exact existing external file formats.

**Architecture:** Raw authenticated uploads spool to owned staging directories, are parsed from disk in fixed chunks, then publish through content-addressed file KV only after validation. RPack is byte substitution and can decode streaming; client registers the returned module after server success.

**Tech Stack:** Node 22, Express, Node streams/fs, fflate Unzip, Vitest, TypeScript/Svelte, XMLHttpRequest.

---

## Invariants and file map

- Preserve risum v0: bytes 111, 0, uint32LE metadata length, RPack metadata, repeated mark 1 plus uint32LE asset length plus RPack asset, terminal mark 0.
- Large routes never use express.raw, Buffer.concat, File.arrayBuffer, or Blob.arrayBuffer.
- Publish all asset KV keys only after full validation. Staged physical objects before a rejected manifest are unreferenced, not published.
- Rewrite module.assets[index][1] to assets/<sha256>.png. Client assigns new UUID and persists module after server return.
- Standard ZIP up to 4 GiB is supported. ZIP64 returns an explicit unsupported error until a separately-approved parser dependency exists.

| File | Responsibility |
| --- | --- |
| server/node/import-stream.cjs | owned staging, spool, abort and disk checks |
| server/node/rpack-map.cjs | server decode map |
| server/node/rpack-stream.cjs | bounded RPack transform |
| server/node/risum-import.cjs | parser and staged asset publish |
| server/node/risum-import-route.cjs | auth, lock and NDJSON |
| server/node/save-folder-zip-import.cjs | staged streaming ZIP extraction |
| server/node/file-kv.cjs | full manifest replacement from files |
| src/ts/storage/nodeStorage.ts | XHR transports |
| src/ts/storage/autoStorage.ts | forwarding |
| src/ts/process/modules.ts and src/ts/util.ts | original File selection |

## Task 1: Common disk spool

**Files:**

- Create: server/node/import-stream.cjs
- Create: server/node/import-stream.test.ts

- [ ] **Step 1: Write the failing test**

~~~ts
it('spools chunks without concatenating them', async () => {
  const result = await spoolSourceToOwnedFile(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), {
    stagingRoot: root, prefix: 'test-', filename: 'input.bin', maxBytes: 4,
  });
  expect(result.bytes).toBe(4);
  expect(await readFile(result.filePath, 'utf8')).toBe('abcd');
});
it('removes owned staging when the byte limit is exceeded', async () => {
  await expect(spoolSourceToOwnedFile(Readable.from([Buffer.alloc(5)]), options)).rejects
    .toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED' });
});
~~~

- [ ] **Step 2: Run the test to verify RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/import-stream.test.ts

Expected: FAIL because import-stream.cjs does not exist.

- [ ] **Step 3: Implement the minimal primitive**

~~~js
class ImportStreamError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'ImportStreamError'; this.code = code; this.status = status;
  }
}
function importAborted() { return new ImportStreamError('IMPORT_ABORTED', 'Import aborted', 499); }
function importLimit() { return new ImportStreamError('IMPORT_LIMIT_EXCEEDED', 'Import exceeds allowed size', 413); }
function insufficientStorage() { return new ImportStreamError('INSUFFICIENT_STORAGE', 'Insufficient disk space', 507); }

async function spoolSourceToOwnedFile(source, options) {
  // mkdtemp stagingRoot/prefix; iterate source; check signal, byte limit and
  // getAvailableBytes before each write; await drain; fsync/end; remove ownedDir on catch.
  // Return { ownedDir, filePath, bytes }.
}
module.exports = { ImportStreamError, importAborted, importLimit, insufficientStorage, spoolSourceToOwnedFile };
~~~

Use createWriteStream with wx and mode 0600. Do not concatenate chunks.

- [ ] **Step 4: Run the test to verify GREEN**

Run: pnpm vitest run --config vitest.config.server.ts server/node/import-stream.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/import-stream.cjs server/node/import-stream.test.ts
git commit -m "feat(import): add disk spool primitive"
~~~

## Task 2: Streaming RPack decode

**Files:**

- Create: server/node/rpack-map.cjs
- Create: server/node/rpack-stream.cjs
- Create: server/node/rpack-stream.test.ts
- Reference: src/ts/rpack/rpack_js.js lines 16-31

- [ ] **Step 1: Write the failing tests**

~~~ts
it('decodes client RPack in non-aligned chunks', async () => {
  const encoded = Buffer.from(await encodeRPack(Buffer.from('streaming-compatible')));
  await writeFile(input, encoded);
  await decodeRPackRangeToFile({ sourcePath: input, start: 0, length: encoded.length, targetPath: output, chunkBytes: 3 });
  expect(await readFile(output, 'utf8')).toBe('streaming-compatible');
});
it('matches all 256 client encoding values', async () => {
  const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  // encode through client, decode through server, expect original
});
~~~

- [ ] **Step 2: Run RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/rpack-stream.test.ts

Expected: FAIL because server decoder does not exist.

- [ ] **Step 3: Implement the decoder**

Generate a literal inverse decode map in rpack-map.cjs from the authoritative rpack_map.bin at development time. Do not read a source-tree path at runtime.

~~~js
async function decodeRPackRangeToFile({ sourcePath, start, length, targetPath, chunkBytes = 64 * 1024, maxOutputBytes = Infinity, signal, onChunk = () => {} }) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) throw new RangeError('Invalid RPack range');
  if (length > maxOutputBytes) throw importLimit();
  // Read exactly min(remaining, chunkBytes), replace each byte with RPACK_DECODE_MAP[byte],
  // write, invoke onChunk, close and sync both handles in finally.
  return { bytes: length };
}
~~~

- [ ] **Step 4: Run GREEN**

Run: pnpm vitest run --config vitest.config.server.ts server/node/rpack-stream.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/rpack-map.cjs server/node/rpack-stream.cjs server/node/rpack-stream.test.ts
git commit -m "feat(import): stream RPack decode on server"
~~~

## Task 3: Disk-backed risum parser

**Files:**

- Create: server/node/risum-import.cjs
- Create: server/node/risum-import.test.ts
- Reference: src/ts/process/modules.ts lines 72-294

- [ ] **Step 1: Write failing parser tests**

Generate test files with WriteStream, never a giant Buffer. Cover valid no-asset and multi-asset files; bad magic/version; truncated uint32; out-of-file length; malformed RPack/JSON; wrong type; metadata, entry, per-asset and total limits; dedupe; publish failure; disk full; abort; monotonic progress.

~~~ts
it('publishes decoded assets under hash keys and rewrites module refs', async () => {
  const result = await importRisumFile({ archivePath, stagingRoot, publishAssets, limits: testLimits });
  expect(result.module.assets?.[0][1]).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
  expect(published).toEqual([{ key: result.module.assets?.[0][1], sourcePath: expect.any(String) }]);
});
it('does not publish after a parser failure', async () => {
  await expect(importRisumFile({ archivePath: corrupt, stagingRoot, publishAssets }))
    .rejects.toMatchObject({ code: 'INVALID_RISUM' });
  expect(published).toEqual([]);
});
~~~

- [ ] **Step 2: Run RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/risum-import.test.ts

Expected: FAIL because importRisumFile is missing.

- [ ] **Step 3: Implement parser contract**

~~~js
const DEFAULT_RISUM_LIMITS = Object.freeze({
  compressedBytes: 4 * 1024 ** 3,
  metadataBytes: 64 * 1024 ** 2,
  entries: 100_000,
  assetDecodedBytes: 256 * 1024 ** 2,
  decodedBytes: 32 * 1024 ** 3,
  diskHeadroomBytes: 512 * 1024 ** 2,
  ioChunkBytes: 64 * 1024,
});
async function importRisumFile({ archivePath, stagingRoot, publishAssets, limits = DEFAULT_RISUM_LIMITS, signal, getAvailableBytes, onProgress = () => {} }) {
  // Return { module, assets, decodedBytes } only after publishAssets succeeds.
}
~~~

Implementation rules:

1. Check stat size against compressedBytes. readExactly(handle, position, length, size) checks safe integer math and range before allocation.
2. Decode metadata to metadata.json using Task 2, parse strict UTF-8, require type risuModule and object module.
3. Allow only mark 1 asset records and final mark 0 at exact EOF.
4. Decode each range to asset-N.decoded, hash in onChunk, and check per-asset, cumulative and disk limits on every chunk.
5. Require module.assets array and exact asset-record count parity.
6. Rewrite asset middle value to assets/hash.png and dedupe publish entries by full key.
7. Call publishAssets exactly once after all entries validate; remove owned staging in finally.

- [ ] **Step 4: Run GREEN**

Run: pnpm vitest run --config vitest.config.server.ts server/node/risum-import.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/risum-import.cjs server/node/risum-import.test.ts
git commit -m "feat(import): stage large risum files on disk"
~~~

## Task 4: Authenticated raw NDJSON risum route

**Files:**

- Create: server/node/risum-import-route.cjs
- Create: server/node/risum-import-route.test.ts
- Modify: server/node/server.cjs lines 43-44, 786-791 and 4300-4318
- Modify: server/node/import-parallelism.test.ts

- [ ] **Step 1: Write failing route tests**

Test auth/session failure, lock 409, content type 415, content-length 413, preflight 507, disconnect abort, heartbeat/progress/done/error NDJSON and socket/request timeout restoration.

~~~ts
expect(events).toContainEqual(expect.objectContaining({ type: 'done', result: { module: expect.any(Object) } }));
expect(beginImport).toHaveBeenCalledTimes(1);
expect(endImport).toHaveBeenCalledTimes(1);
~~~

- [ ] **Step 2: Run RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/risum-import-route.test.ts

Expected: FAIL because route factory is missing.

- [ ] **Step 3: Implement and wire**

Adapt transport lifecycle only from charx-import-route.cjs:

~~~js
function createRisumImportHandler(deps) {
  return async function risumImportHandler(req, res) {
    // authenticate/session/lock; require application/x-risu-module; suspend body timeout
    // while spoolSourceToOwnedFile receives request; write no-transform NDJSON;
    // parse with importRisumFile; emit progress and one done; always restore and unlock.
  };
}
~~~

In server.cjs add risum and ZIP upload to raw bypass:

~~~js
if (req.path === '/api/backup/import' || req.path === '/api/charx/import'
  || req.path === '/api/risum/import' || req.path === '/api/migrate/save-folder/upload') return next();
~~~

Wire POST /api/risum/import with existing checkAuth/checkActiveSession/importInProgress, staging root savePath/risum-imports, statfsSync free bytes, and publishAssets: entries => kvSetManyFromFilesAsync(entries).

- [ ] **Step 4: Run GREEN**

Run: pnpm vitest run --config vitest.config.server.ts server/node/risum-import-route.test.ts server/node/import-parallelism.test.ts

Expected: PASS; static source guard rejects Buffer.concat(chunks) in the new route.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/risum-import-route.cjs server/node/risum-import-route.test.ts server/node/server.cjs server/node/import-parallelism.test.ts
git commit -m "feat(import): add authenticated risum upload route"
~~~

## Task 5: Original browser File route and client registration

**Files:**

- Modify: src/ts/util.ts
- Modify: src/ts/storage/nodeStorage.ts lines 84-101 and 634-718
- Modify: src/ts/storage/autoStorage.ts
- Modify: src/ts/process/modules.ts lines 330-365
- Create: src/ts/storage/nodeStorage.risum.test.ts
- Modify: src/ts/process/modules.test.ts

- [ ] **Step 1: Write failing client tests**

~~~ts
it('sends original File without arrayBuffer', async () => {
  const file = new File(['module'], 'large.risum', { type: 'application/x-risu-module' });
  const spy = vi.spyOn(file, 'arrayBuffer');
  const pending = storage.importRisum(file);
  expect(FakeXhr.instances[0].url).toBe('/api/risum/import');
  expect(FakeXhr.instances[0].sent).toBe(file);
  expect(spy).not.toHaveBeenCalled();
  // Finish NDJSON done and await pending.
});
~~~

Assert Node module path calls forageStorage.importRisum, assigns a new UUID, and pushes once. Assert legacy small non-Node risum still uses existing readModule path.

- [ ] **Step 2: Run RED**

Run: pnpm vitest run src/ts/storage/nodeStorage.risum.test.ts src/ts/process/modules.test.ts

Expected: FAIL because File path and importRisum do not exist.

- [ ] **Step 3: Implement**

Add to util.ts without changing selectSingleFile:

~~~ts
export async function selectNativeFile(accept: string): Promise<File | null> {
  return await new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
~~~

Add NodeStorage types and method:

~~~ts
export interface ServerRisumImportResult { module: RisuModule; assets: number; decodedBytes: number }
export type ServerRisumImportProgress =
  | { phase: 'upload'; loaded: number; total: number }
  | { phase: 'validate' | 'assets' | 'publish' | 'register'; completed: number; total: number };
async importRisum(file: File, onProgress?: (event: ServerRisumImportProgress) => void): Promise<ServerRisumImportResult>
~~~

Use CharX incremental NDJSON XHR pattern with POST /api/risum/import, auth/session headers, and xhr.send(file). In modules.ts choose native File before any decoded helper when Node risum. On success set result.module.id = v4(), push once, notify success. Non-Node risum larger than 128 MiB errors before local decode.

- [ ] **Step 4: Run GREEN**

Run: pnpm vitest run src/ts/storage/nodeStorage.risum.test.ts src/ts/process/modules.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/ts/util.ts src/ts/storage/nodeStorage.ts src/ts/storage/autoStorage.ts src/ts/process/modules.ts src/ts/storage/nodeStorage.risum.test.ts src/ts/process/modules.test.ts
git commit -m "feat(modules): import large risum files through node"
~~~

## Task 6: Atomic file-KV replacement from staged files

**Files:**

- Modify: server/node/file-kv.cjs lines 232-293 and 416-424
- Modify: server/node/file-kv.test.ts

- [ ] **Step 1: Write failing tests**

~~~ts
it('replaces full manifest only after every staged file prepares', async () => {
  kvSet('database/database.bin', Buffer.from('old'));
  await kvReplaceAllFromFilesAsync([
    { key: 'database/database.bin', sourcePath: newDb },
    { key: 'assets/a.png', sourcePath: asset },
  ]);
  expect(kvGet('database/database.bin')?.toString()).toBe('new-db');
});
it('preserves old manifest when one source path is missing', async () => { /* expect old DB readable */ });
~~~

- [ ] **Step 2: Run RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/file-kv.test.ts

Expected: FAIL because kvReplaceAllFromFilesAsync is absent.

- [ ] **Step 3: Implement**

~~~js
async function kvReplaceAllFromFilesAsync(entries) {
  const prepared = await prepareFileEntriesAsync(entries);
  await queueManifestCommit(async () => {
    const next = { schemaVersion: 1, updatedAt: Date.now(), entries: Object.fromEntries(prepared) };
    await commitManifest(next);
  });
}
~~~

Export it. Do not use mutateManifest: it reveals a replacement before preparation finishes.

- [ ] **Step 4: Run GREEN**

Run: pnpm vitest run --config vitest.config.server.ts server/node/file-kv.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/file-kv.cjs server/node/file-kv.test.ts
git commit -m "feat(storage): atomically replace kv from staged files"
~~~

## Task 7: Disk streaming save-folder ZIP

**Files:**

- Create: server/node/save-folder-zip-import.cjs
- Create: server/node/save-folder-zip-import.test.ts
- Modify: server/node/server.cjs lines 26-28 and 5156-5220
- Modify: server/node/import-parallelism.test.ts
- Modify: test/compat/remote-block-migration.test.ts

- [ ] **Step 1: Write failing tests**

Cover good hex entries, missing/duplicate database key, traversal/absolute/backslash archive names, invalid hex, duplicate decoded key, entry/ratio/decoded limits, abort, ENOSPC, and old-manifest preservation.

- [ ] **Step 2: Run RED**

Run: pnpm vitest run --config vitest.config.server.ts server/node/save-folder-zip-import.test.ts

Expected: FAIL because importer is missing.

- [ ] **Step 3: Implement**

~~~js
const DEFAULT_SAVE_FOLDER_ZIP_LIMITS = Object.freeze({
  compressedBytes: 4 * 1024 ** 3, entries: 100_000,
  entryBytes: 256 * 1024 ** 2, decompressedBytes: 32 * 1024 ** 3,
  maxExpansionRatio: 200, diskHeadroomBytes: 512 * 1024 ** 2,
});
async function importSaveFolderZip({ source, stagingRoot, replaceAllFromFiles, limits, signal, getAvailableBytes, onProgress }) {
  // spool source then feed 64 KiB staged file reads into fflate.Unzip/UnzipInflate;
  // write each validated entry to a staged file and call replaceAllFromFiles(entries) once.
}
~~~

Validate entire archive path before basename. Valid basename is hex, strict UTF-8 decodes to nonempty safe KV key. Require exactly one database/database.bin. Reject ZIP64 clearly.

Replace old chunks/zipBuffer/unzip route logic. Keep post-publish order:

~~~js
await flushPendingDb();
maybeCollectUnreferencedObjects();
invalidateDbCache();
await kvReplaceAllFromFilesAsync(entries);
relationalSql.reset();
writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
~~~

- [ ] **Step 4: Run GREEN**

Run these separately:

~~~powershell
pnpm vitest run --config vitest.config.server.ts server/node/save-folder-zip-import.test.ts server/node/import-parallelism.test.ts
pnpm vitest run --config vitest.config.compat.ts test/compat/remote-block-migration.test.ts
~~~

Expected: PASS; source guard rejects old zipBuffer and Buffer.concat(chunks) route path.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/save-folder-zip-import.cjs server/node/save-folder-zip-import.test.ts server/node/server.cjs server/node/import-parallelism.test.ts test/compat/remote-block-migration.test.ts
git commit -m "feat(import): stream save-folder zip migration"
~~~

## Task 8: Raw binary single-asset upload

**Files:**

- Modify: server/node/server.cjs lines 3955-4048
- Modify: src/ts/storage/nodeStorage.ts lines 471-521
- Modify: src/ts/storage/autoStorage.ts
- Create: server/node/asset-upload-route.test.ts
- Create: src/ts/storage/nodeStorage.assets.test.ts

- [ ] **Step 1: Write failing tests**

~~~ts
it('sends Blob body instead of base64 JSON', async () => {
  await storage.setItemStreamed('assets/test.png', new Blob(['pixels']));
  expect(FakeXhr.instances[0].url).toBe('/api/assets/upload');
  expect(FakeXhr.instances[0].headers['x-risu-asset-key']).toBe('assets/test.png');
  expect(FakeXhr.instances[0].sent).toBeInstanceOf(Blob);
});
~~~

Test server invalid key/auth/session/limit and file-backed KV publish.

- [ ] **Step 2: Run RED**

Run these separately:

~~~powershell
pnpm vitest run --config vitest.config.server.ts server/node/asset-upload-route.test.ts
pnpm vitest run src/ts/storage/nodeStorage.assets.test.ts
~~~

Expected: FAIL because API is missing.

- [ ] **Step 3: Implement**

Create authenticated POST /api/assets/upload with octet stream and x-risu-asset-key. Validate assets prefix and reject NUL, backslash, absolute path and dot-dot. Use Task 1 spool, 256 MiB cap, then:

~~~js
await kvSetManyFromFilesAsync([{ key, sourcePath: spooled.filePath }]);
~~~

Add setItemStreamed to NodeStorage and AutoStorage. Retain current JSON base64 setItems as compatibility fallback for values <= 8 MiB, use raw route for larger single values. Do not use fetch request-streaming because iOS Safari support is unsuitable.

- [ ] **Step 4: Run GREEN**

Run these separately:

~~~powershell
pnpm vitest run --config vitest.config.server.ts server/node/asset-upload-route.test.ts
pnpm vitest run src/ts/storage/nodeStorage.assets.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add server/node/server.cjs server/node/asset-upload-route.test.ts src/ts/storage/nodeStorage.ts src/ts/storage/autoStorage.ts src/ts/storage/nodeStorage.assets.test.ts
git commit -m "feat(storage): stream large binary asset uploads"
~~~

## Task 9: Opt-in generated 3 GiB harness

**Files:**

- Create: server/node/large-import-harness.test.ts
- Modify: package.json

- [ ] **Step 1: Write test**

~~~ts
const largeIt = process.env.RISU_RUN_LARGE_IMPORT === '1' ? it : it.skip;
largeIt('imports generated 3 GiB risum with bounded RSS', async () => {
  const before = process.memoryUsage().rss; const samples: number[] = [];
  const timer = setInterval(() => samples.push(process.memoryUsage().rss), 100);
  try {
    await writeGeneratedRisum(archivePath, 3 * 1024 ** 3, { chunkBytes: 64 * 1024 });
    await importRisumFile({ archivePath, stagingRoot, publishAssets, limits: DEFAULT_RISUM_LIMITS });
  } finally { clearInterval(timer); }
  expect(Math.max(before, ...samples) - before).toBeLessThanOrEqual(512 * 1024 ** 2);
});
~~~

Generator writes direct WriteStream records in 64 KiB deterministic chunks and never constructs a 3 GiB Buffer. Default CI skips the case; a 128 MiB fixture executes same parser path.

- [ ] **Step 2: Run default gate**

Run: pnpm vitest run --config vitest.config.server.ts server/node/large-import-harness.test.ts

Expected: PASS with 3 GiB case skipped.

- [ ] **Step 3: Add and run explicit harness command**

Add package script:

~~~json
"test:large-import": "set RISU_RUN_LARGE_IMPORT=1&& vitest run --config vitest.config.server.ts server/node/large-import-harness.test.ts"
~~~

Run:

~~~powershell
$env:RISU_RUN_LARGE_IMPORT='1'
pnpm vitest run --config vitest.config.server.ts server/node/large-import-harness.test.ts
Remove-Item Env:RISU_RUN_LARGE_IMPORT
~~~

Expected: PASS; record peak RSS, elapsed time, counts and cleanup. Do not commit generated files.

- [ ] **Step 4: Commit**

~~~powershell
git add server/node/large-import-harness.test.ts package.json
git commit -m "test(import): add opt-in large risum harness"
~~~

## Task 10: Verification and review

**Files:**

- Modify only relevant files above when a verified failure requires it.

- [ ] **Step 1: Run focused suites**

~~~powershell
pnpm vitest run --config vitest.config.server.ts server/node/import-stream.test.ts server/node/rpack-stream.test.ts server/node/risum-import.test.ts server/node/risum-import-route.test.ts server/node/save-folder-zip-import.test.ts server/node/file-kv.test.ts server/node/asset-upload-route.test.ts server/node/import-parallelism.test.ts
pnpm vitest run src/ts/process/modules.test.ts src/ts/storage/nodeStorage.risum.test.ts src/ts/storage/nodeStorage.assets.test.ts
~~~

Expected: PASS.

- [ ] **Step 2: Run project gates**

~~~powershell
pnpm check
pnpm build
pnpm test:server
pnpm test:compat
~~~

Expected: all pass; distinguish pre-existing warnings from failures.

- [ ] **Step 3: Device release check**

On iPhone 13+/iOS 17 through Tailscale: import large risum; cancel upload and processing then retry; import save-folder ZIP and restart server; upload and render >8 MiB asset. Confirm no partial module, broken reference, WebKit reload, or staging directory.

- [ ] **Step 4: Request code review**

Review length arithmetic, timeout restoration, abort cleanup, raw parser bypasses, key/path validation, manifest atomicity, and absence of arrayBuffer/Buffer.concat in large-file paths.

## Plan self-review

- Coverage: Tasks 1-5 implement authenticated NDJSON risum; Tasks 6-7 file KV and save ZIP; Task 8 binary assets; Task 9 generated memory proof; Task 10 release gates.
- Type consistency: ServerRisumImportResult, ServerRisumImportProgress, importRisum, kvReplaceAllFromFilesAsync, and importSaveFolderZip have one spelling throughout.
- External formats are not changed; only transport and parsing placement change.
