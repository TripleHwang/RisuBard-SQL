# Obsolete WAL Cleanup Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the no-op SQLite WAL cleanup route and dashboard controls left behind after file-native persistence replaced SQLite.

**Architecture:** Keep the in-memory application database, `database.bin` compatibility projection, legacy SQLite importer, file-object garbage collection, and all import/export contracts unchanged. Delete only the endpoint and UI surface that report and clean a WAL that file-native storage never creates.

**Tech Stack:** Node.js, Express, Svelte 5, TypeScript, Vitest

---

### Task 1: Lock the removed runtime surface with a failing contract test

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('does not expose the obsolete WAL checkpoint route or dashboard control', () => {
    const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
    const dashboard = fs.readFileSync(
        path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
        'utf8',
    )

    expect(server).not.toContain("app.post('/api/db/wal-checkpoint'")
    expect(dashboard).not.toContain('/api/db/wal-checkpoint')
    expect(dashboard).not.toContain('walCleanupOpen')
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL because `server.cjs` still declares `/api/db/wal-checkpoint`.

### Task 2: Remove the no-op server and dashboard implementation

**Files:**
- Modify: `server/node/server.cjs`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`

- [x] **Step 1: Delete the server route**

Remove the complete `app.post('/api/db/wal-checkpoint', ...)` block. Do not change `/api/db/optimize`, `gcChunks`, legacy SQLite import, or compatibility snapshot endpoints.

- [x] **Step 2: Delete the dashboard WAL state and request function**

Remove `walCleanupOpen`, `runWalCleanup`, the conditional WAL cleanup card, and its `ShLoadingDialog`. Keep file-object cleanup and `runOptimize` unchanged.

- [x] **Step 3: Delete unreachable language entries**

Remove the `storageWalCleanup*` entries from `src/lang/en.ts` and `src/lang/ko.ts`; no other locale declares them.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: PASS with four tests.

- [x] **Step 5: Run affected static checks**

Run: `pnpm check`

Expected: PASS without references to deleted `storageWalCleanup*` fields.

Actual: The changed files have no diagnostics. The repository-wide command remains blocked by the pre-existing `packages/risubard-core/src/narrativeIndex.ts:36` TypeScript error (`term` inferred as `never`); four unrelated Svelte accessibility warnings are also reported.

- [x] **Step 6: Commit the completed slice**

```powershell
git add docs/superpowers/plans/2026-08-20-remove-obsolete-wal-cleanup.md server/node/no-sqlite-runtime.test.ts server/node/server.cjs src/lib/Setting/Pages/SystemDashboard.svelte src/lang/en.ts src/lang/ko.ts
git commit -m "refactor: remove obsolete WAL cleanup path"
```

### Task 3: Remove residual no-op WAL maintenance internals

**Files:**
- Modify: `server/node/file-kv.cjs`
- Modify: `server/node/server.cjs`
- Modify: `server/node/no-sqlite-runtime.test.ts`

- [x] **Step 1: Add a failing contract test for the no-op hook and stale server path**
- [x] **Step 2: Remove `checkpointWal`, the empty backup-import block, and stale WAL comments**
- [x] **Step 3: Verify file KV, legacy SQLite import, and `database.bin` recovery tests**

### Task 4: Remove unreachable WAL/SHM dashboard wiring

**Files:**
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`
- Modify: `server/node/no-sqlite-runtime.test.ts`

- [x] **Step 1: Add a failing contract test for dashboard WAL/SHM references**
- [x] **Step 2: Remove the zero-size dashboard rows, footprint terms, and unused translations**
- [x] **Step 3: Keep the server's zero-valued response fields for older client compatibility**
- [x] **Step 4: Verify CHARX, module, plugin, and end-to-end backup compatibility suites**
