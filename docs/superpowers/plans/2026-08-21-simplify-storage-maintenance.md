# Storage Maintenance Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop automatic compatibility snapshots, remove duplicate server-backup surfaces, and make file-object cleanup reclaim real disk space with accurate physical metrics.

**Architecture:** Keep legacy snapshot and server-backup endpoints for old clients, but remove their automatic and user-facing entry points. Treat `kv/objects` as a content-addressed object store: the manifest defines reachability, manual GC permanently removes unreachable objects, and background GC removes only objects older than a safety grace period. Report physical object-store bytes rather than the logical sum of manifest rows.

**Tech Stack:** Node.js CommonJS storage backend, Svelte 5 settings UI, TypeScript, Vitest.

---

### Task 1: Specify physical object-store cleanup

**Files:**
- Modify: `server/node/file-kv.test.ts`
- Modify: `server/node/file-kv.cjs`

- [ ] **Step 1: Write failing cleanup tests**

Extend the prefix/deletion test to require `objectStoreBytes()` and a structured GC result:

```ts
expect(store.objectStoreBytes()).toBe(9)
store.kvDelPrefix('assets/')
expect(store.gcChunks()).toEqual({ count: 2, bytes: 7 })
expect(store.objectStoreBytes()).toBe(2)
expect(fs.existsSync(path.join(dataRoot, 'trash'))).toBe(false)
```

Add a test that sets deterministic object mtimes and verifies `gcChunks({ minAgeMs, now })` removes only an old unreachable object.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/file-kv.test.ts`

Expected: FAIL because `objectStoreBytes` is absent and `gcChunks` returns a number after moving files to trash.

- [ ] **Step 3: Implement permanent, measurable GC**

In `file-kv.cjs`, add:

```js
function objectStoreBytes() {
    const directory = path.join(dataRoot, 'kv', 'objects');
    if (!fs.existsSync(directory)) return 0;
    return fs.readdirSync(directory).reduce((total, name) => {
        try { return total + fs.statSync(path.join(directory, name)).size; }
        catch { return total; }
    }, 0);
}
```

Change `gcChunks(options = {})` to filter unreachable objects by `minAgeMs`, permanently unlink them, sum deleted bytes, and return `{ count, bytes }`. Export `objectStoreBytes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/file-kv.test.ts`

Expected: PASS.

### Task 2: Disable automatic snapshots and automate safe GC

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`
- Modify: `server/node/server.cjs`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`

- [ ] **Step 1: Write failing runtime policy tests**

Add source-contract assertions that `server.cjs` contains no `createBackupAndRotate` or snapshot interval, uses `maybeCollectUnreferencedObjects`, uses `objectStoreBytes()` for stats/optimization, returns `gcResult.bytes`, and no longer rejects deletion-only cleanup for low free space.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts`

Expected: FAIL on the current automatic snapshot and logical-size implementation.

- [ ] **Step 3: Implement the policy**

Import `objectStoreBytes` from the file-KV facade. Replace snapshot scheduling with a five-minute GC cooldown and one-hour object grace:

```js
function maybeCollectUnreferencedObjects() {
    const now = Date.now();
    if (lastGcTime && now - lastGcTime < GC_INTERVAL_MS) return;
    lastGcTime = now;
    gcChunks({ minAgeMs: GC_MIN_AGE_MS, now });
}
```

Replace all automatic `createBackupAndRotate()` calls with this collector. Preserve snapshot list/restore endpoints and existing snapshot keys. Use physical object-store bytes for `/api/db/stats` and `/api/db/optimize`; manual optimize calls `gcChunks()` without a grace and reports its returned byte count. Remove the obsolete free-space precondition.

- [ ] **Step 4: Run policy and storage tests**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts server/node/file-kv.test.ts`

Expected: PASS.

### Task 3: Remove duplicate backup surfaces

**Files:**
- Create: `src/lib/Setting/Pages/SystemBackup.test.ts`
- Modify: `src/lib/Setting/Pages/SystemBackup.svelte`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`
- Modify: `src/lib/Others/UpdatePopup.svelte`
- Modify: `src/ts/bootstrap.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`

- [ ] **Step 1: Write a failing UI contract test**

Read the active frontend files and assert that the backup page retains `SaveLocalBackup`, `SaveSettingsOnlyBackup`, and `LoadLocalBackup`, while active UI/bootstrap sources contain no `SaveServerBackup`, `/api/backup/server`, `/api/backup/boot-reminder`, `backupSnapshot`, or `ServerBackupList`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/Setting/Pages/SystemBackup.test.ts`

Expected: FAIL because server backup, boot reminder, and snapshot UI are still active.

- [ ] **Step 3: Simplify active UI**

Reduce `SystemBackup.svelte` to the full local export, settings-only export, and local restore actions. Remove server-backup and snapshot cards/dialogs. Remove the dashboard backup summary/card and configured-backup-directory bytes from its internal footprint. Change the updater safety button to call `SaveLocalBackup`. Remove the boot reminder fetch/prompt path from `bootstrap.ts`. Update the backup-tab descriptions to describe full and settings backups only.

- [ ] **Step 4: Run the UI contract test**

Run: `pnpm vitest run src/lib/Setting/Pages/SystemBackup.test.ts`

Expected: PASS.

### Task 4: Validate the affected system

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
pnpm vitest run src/lib/Setting/Pages/SystemBackup.test.ts
pnpm vitest run --config vitest.config.server.ts server/node/file-kv.test.ts server/node/no-sqlite-runtime.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run static checks**

Run: `pnpm check`

Expected: exit code 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check` and a path-scoped `git diff` over the files in this plan. Confirm unrelated existing changes are preserved and no current user data or snapshots were deleted.
