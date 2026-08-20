# Data Import Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CharX, backup, and save-folder imports use bounded batching and multicore-capable asynchronous work without weakening atomic file-native storage guarantees.

**Architecture:** Browser imports batch asset hashing and persistence in groups of at most 50 items or 32 MiB, while fflate moves compressed CharX entries off the UI thread. Server imports prepare content-addressed objects with bounded WebCrypto and asynchronous file I/O, then publish the manifest once through the existing atomic writer.

**Tech Stack:** TypeScript, JavaScript, fflate Web Workers/worker_threads, WebCrypto, Node.js `fs/promises`, Vitest, Vite.

---

### Task 1: Browser asset import batching

**Files:**
- Create: `src/ts/storage/assetImportBatcher.ts`
- Create: `src/ts/storage/assetImportBatcher.test.ts`
- Modify: `src/ts/process/processzip.ts`

- [ ] **Step 1: Write the failing batch-boundary test**

```ts
const batcher = new AssetImportBatcher({ hash, setItems, saveAsset })
for (let index = 0; index < 51; index++) batcher.enqueue({ id: String(index), data: Uint8Array.of(index) })
await batcher.done()
expect(setItems.mock.calls.map(call => call[0].length)).toEqual([50, 1])
```

- [ ] **Step 2: Run the test and verify that `AssetImportBatcher` is absent**

Run: `node_modules/.bin/vitest.cmd run src/ts/storage/assetImportBatcher.test.ts`

- [ ] **Step 3: Implement bounded batching**

```ts
export class AssetImportBatcher {
  enqueue(asset: ImportAsset): void
  waitForCapacity(): Promise<void>
  done(): Promise<void>
}
```

The implementation groups at 50 items or 32 MiB, hashes each group concurrently, calls `forageStorage.setItems` once per group, and uses the existing binary `saveAsset` path for a single oversized asset.

- [ ] **Step 4: Connect CharX streaming import**

Register `fflate.AsyncUnzipInflate`, enqueue completed assets into `AssetImportBatcher`, await capacity after each input chunk, and await `batcher.done()` during finalization.

- [ ] **Step 5: Run browser import tests**

Run: `node_modules/.bin/vitest.cmd run src/ts/storage/assetImportBatcher.test.ts src/ts/process/modules.test.ts src/ts/rpack/rpack_js.test.ts`

### Task 2: Atomic asynchronous file-KV preparation

**Files:**
- Modify: `server/node/file-kv.cjs`
- Modify: `server/node/file-kv.test.ts`

- [ ] **Step 1: Write the failing async replacement test**

```ts
await store.kvReplaceAllAsync([
  { key: 'database/database.bin', value: Buffer.from('db') },
  { key: 'assets/a', value: Buffer.from('asset') },
])
expect(createFileKv({ dataRoot }).kvList()).toEqual(['assets/a', 'database/database.bin'])
```

- [ ] **Step 2: Run the test and verify the method is missing**

Run: `node_modules/.bin/vitest.cmd run --config vitest.config.server.ts server/node/file-kv.test.ts`

- [ ] **Step 3: Implement limited parallel object preparation**

```js
async function prepareEntriesAsync(entries) {
  return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
    const hash = await digestAsync(value)
    await writeObjectAsync(dataRoot, hash, value)
    return [key, { object: hash, size: value.length, updatedAt: Date.now() }]
  })
}
```

Publish the resulting manifest only after every object has been fsynced and checksum-verified; failed preparation must leave the current manifest unchanged.

- [ ] **Step 4: Run the file-KV tests**

Run: `node_modules/.bin/vitest.cmd run --config vitest.config.server.ts server/node/file-kv.test.ts`

### Task 3: Backup and save-folder import integration

**Files:**
- Modify: `server/node/server.cjs`
- Test: existing server backup compatibility and file-KV suites

- [ ] **Step 1: Switch backup publication to `kvReplacePrefixesAsync`**

```js
await kvReplacePrefixesAsync(stagedKvEntries, importedPrefixes)
```

- [ ] **Step 2: Switch save-folder publication to `kvReplaceAllAsync` and bounded async reads**

```js
const entries = await mapWithConcurrency(hexFiles, importConcurrency, async hexFile => ({
  key: Buffer.from(hexFile, 'hex').toString('utf-8'),
  value: await fs.readFile(path.join(dirPath, hexFile)),
}))
await kvReplaceAllAsync(entries)
```

- [ ] **Step 3: Replace uploaded ZIP `unzipSync` with fflate's worker-thread `unzip`**

```js
const unzipped = await new Promise((resolve, reject) => {
  fflate.unzip(new Uint8Array(zipBuffer), (error, data) => error ? reject(error) : resolve(data))
})
```

- [ ] **Step 4: Run targeted server tests and production build**

Run: `node_modules/.bin/vitest.cmd run --config vitest.config.server.ts server/node/file-kv.test.ts`

Run: `node_modules/.bin/vite.cmd build --sourcemap false`

