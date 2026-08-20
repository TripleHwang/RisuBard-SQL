# File Storage Stats Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current dashboard consume explicit file-native storage metrics while retaining the legacy SQLite-shaped stats response for older clients.

**Architecture:** `/api/db/stats` will expose a new `storage` object sourced from file KV measurements and continue returning the existing `sqlite`, `chunks`, and `files.wal/shm` compatibility fields unchanged. The dashboard normalizes older server responses at its fetch boundary, then uses only `stats.storage` internally.

**Tech Stack:** Node.js, Express, Svelte 5, TypeScript, Vitest

---

### Task 1: Lock the native/legacy stats boundary

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`

- [x] **Step 1: Write the failing contract test**

```ts
it('isolates native storage metrics from the legacy SQLite response', () => {
    const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
    const dashboard = fs.readFileSync(
        path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
        'utf8',
    )

    expect(server).toContain("storage: { reclaimable, mode: 'file-native' }")
    expect(server).toContain('sqlite: {')
    expect(dashboard).toContain('stats.storage.reclaimable')
    expect(dashboard).not.toContain('stats.sqlite.reclaimable')
})
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because the native `storage` object does not exist.

### Task 2: Add native stats without breaking old clients

**Files:**
- Modify: `server/node/server.cjs`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`

- [x] **Step 1: Add the native server response**

Add this property immediately before the retained legacy `sqlite` property:

```js
storage: { reclaimable, mode: 'file-native' },
```

Keep all existing legacy response fields unchanged.

- [x] **Step 2: Normalize old server responses at the dashboard fetch boundary**

Add the required `storage` type and replace the direct assignment with:

```ts
const payload = await res.json()
stats = {
    ...payload,
    storage: payload.storage ?? {
        reclaimable: payload.sqlite?.reclaimable ?? 0,
        mode: payload.sqlite?.journalMode ?? 'legacy',
    },
}
```

- [x] **Step 3: Switch current dashboard consumers to `stats.storage`**

Replace every `stats.sqlite.reclaimable` and `stats.sqlite.journalMode` read with `stats.storage.reclaimable` and `stats.storage.mode`. Retain the `sqlite` payload type only for normalization of older servers.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts server/node/file-kv.test.ts server/node/legacy-sqlite-import.test.ts server/node/db-cache-recovery.test.ts`

Expected: PASS.

- [x] **Step 5: Run compatibility verification**

Run CHARX/module/plugin tests and `pnpm test:compat` after removing `RISUBARD_DATA_ROOT` from the compatibility-test process.

Expected: all non-environment-dependent tests pass.

Actual: Storage tests passed 14/14, CHARX/module/plugin tests passed 51/51, and compatibility tests passed 58/58 with 5 environment-dependent skips. Repository-wide `pnpm check` remains blocked only by the pre-existing `packages/risubard-core/src/narrativeIndex.ts:36` error and four unrelated accessibility warnings.

- [x] **Step 6: Commit and push**

```powershell
git add docs/superpowers/plans/2026-08-20-isolate-file-storage-stats.md server/node/no-sqlite-runtime.test.ts server/node/server.cjs src/lib/Setting/Pages/SystemDashboard.svelte
git commit -m "refactor: isolate file-native storage stats"
```

### Task 3: Inline legacy-only SQLite constants

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`
- Modify: `server/node/server.cjs`

- [x] **Step 1: Add a failing absence contract**

```ts
expect(server).not.toMatch(/const (?:pageSize|pageCount|freelistCount|journalMode|autoVacuum) =/)
```

- [x] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because the legacy-only temporary variables still exist.

- [x] **Step 3: Inline the unchanged legacy response values**

Delete the five temporary declarations and retain their exact JSON values:

```js
sqlite: {
    pageSize: 0,
    pageCount: 0,
    freelistCount: 0,
    reclaimable,
    journalMode: 'atomic-rename',
    autoVacuum: 'file-gc',
},
```

- [x] **Step 4: Run focused and compatibility tests**

Run the server storage tests and the isolated compatibility suite.

Expected: PASS with the legacy wire response unchanged.

- [x] **Step 5: Commit and push**

```powershell
git add docs/superpowers/plans/2026-08-20-isolate-file-storage-stats.md server/node/no-sqlite-runtime.test.ts server/node/server.cjs
git commit -m "refactor: inline legacy storage stats constants"
```
