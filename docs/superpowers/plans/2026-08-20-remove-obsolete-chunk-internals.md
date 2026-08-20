# Obsolete Chunk Internals Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove no-op entity/chunk APIs and duplicate chunk-era dashboard calculations without changing legacy response shapes or user-data formats.

**Architecture:** The file-native KV manifest and content objects remain the only runtime KV implementation. The server continues returning the legacy `files`, `sqlite`, and `chunks` fields from `/api/db/stats` for older clients, but current code no longer calls fake chunk helpers or consumes zero-valued chunk fields.

**Tech Stack:** Node.js, Express, Svelte 5, TypeScript, Vitest

---

### Task 1: Lock obsolete file-KV helpers with a failing contract test

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('does not retain obsolete entity or SQL-chunk helpers', () => {
    const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
    const fileKv = fs.readFileSync(path.join(root, 'server', 'node', 'file-kv.cjs'), 'utf8')

    expect(fileKv).not.toContain('clearEntities')
    expect(fileKv).not.toContain('isDbBlobChunked')
    expect(server).not.toMatch(/\bclearEntities\s*\(/)
    expect(server).not.toMatch(/\bisDbBlobChunked\s*\(/)
})
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because `file-kv.cjs` still exports both no-op helpers.

### Task 2: Remove no-op helpers while retaining wire compatibility

**Files:**
- Modify: `server/node/file-kv.cjs`
- Modify: `server/node/server.cjs`

- [x] **Step 1: Remove both file-KV exports**

Delete these return-object properties:

```js
isDbBlobChunked: () => false,
clearEntities: () => {},
```

- [x] **Step 2: Remove imports and calls**

Remove `clearEntities` and `isDbBlobChunked` from the `db.cjs` destructuring and delete the `clearEntities()` call. Replace the stats implementation with literal compatibility values:

```js
chunks: { count: 0, bytes: 0, orphanBytes: reclaimable, liveChunked: false },
```

- [x] **Step 3: Run the server storage tests and verify GREEN**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts server/node/file-kv.test.ts server/node/legacy-sqlite-import.test.ts server/node/db-cache-recovery.test.ts`

Expected: PASS.

### Task 3: Remove current-dashboard dependence on legacy chunk fields

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`

- [x] **Step 1: Write the failing dashboard contract test**

```ts
expect(dashboard).not.toMatch(/stats\.chunks/)
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because the dashboard still reads `stats.chunks`.

- [x] **Step 3: Delete chunk-era dashboard branches**

Remove the optional `chunks` type, use `get('database/database.bin')` directly for the compatibility projection size, and disable cleanup from `stats.sqlite.reclaimable` alone:

```ts
const dbRowSize = get('database/database.bin')
```

```svelte
disabled={stats.sqlite.reclaimable < 50 * 1024 * 1024}
```

- [x] **Step 4: Verify storage and compatibility boundaries**

Run the server storage tests, CHARX/module/plugin tests, and `pnpm test:compat` with `RISUBARD_DATA_ROOT` removed from the test process.

Expected: all non-environment-dependent tests pass.

Actual: Storage tests passed 13/13, CHARX/module/plugin tests passed 51/51, and compatibility tests passed 58/58 with 5 environment-dependent skips. Repository-wide `pnpm check` remains blocked only by the pre-existing `packages/risubard-core/src/narrativeIndex.ts:36` error and four unrelated accessibility warnings.

- [x] **Step 5: Commit and push the slice**

```powershell
git add docs/superpowers/plans/2026-08-20-remove-obsolete-chunk-internals.md server/node/no-sqlite-runtime.test.ts server/node/file-kv.cjs server/node/server.cjs src/lib/Setting/Pages/SystemDashboard.svelte
git commit -m "refactor: remove obsolete chunk storage internals"
```

### Task 4: Remove the unreachable save-folder cleanup helper

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`
- Modify: `server/node/server.cjs`

- [x] **Step 1: Add a failing absence contract**

```ts
expect(server).not.toContain('function clearExistingData')
```

- [x] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because the uncalled helper is still defined.

- [x] **Step 3: Delete only the `clearExistingData` function**

Keep `importHexFilesFromDir`, `importHexEntries`, all `/api/migrate/save-folder/*` routes, `kvReplaceAll`, and `migrationMarkerPath` unchanged.

- [x] **Step 4: Verify save-folder upload and remote-block compatibility**

Run: `Remove-Item Env:RISUBARD_DATA_ROOT -ErrorAction SilentlyContinue; pnpm vitest run --config vitest.config.compat.ts test/compat/remote-block-migration.test.ts`

Expected: PASS.

- [x] **Step 5: Commit and push the slice**

```powershell
git add docs/superpowers/plans/2026-08-20-remove-obsolete-chunk-internals.md server/node/no-sqlite-runtime.test.ts server/node/server.cjs
git commit -m "refactor: remove unreachable save-folder cleanup helper"
```

## Later conservative phases

1. Audit remaining compatibility-facade methods and remove only proven no-ops.
2. Isolate legacy `/api/db/stats` naming behind the server response boundary without changing its JSON shape.
3. Audit save-folder migration markers and import paths; retain every marker needed to prevent duplicate migration.
4. Stop when remaining code is active compatibility logic rather than database-runtime residue.
