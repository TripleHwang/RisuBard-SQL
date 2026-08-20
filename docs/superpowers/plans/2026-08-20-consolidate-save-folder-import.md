# Save-Folder Import Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicated destructive-apply sequence from the two legacy save-folder import paths without changing validation, response shapes, canonical projection rebuilding, or compatibility behavior.

**Architecture:** Keep directory scanning and ZIP decoding in their existing route-specific functions. Move only the already-identical flush, snapshot, cache invalidation, full KV replacement, and migration-marker write into one local helper in `server.cjs`.

**Tech Stack:** Node.js CommonJS server, Vitest source contracts, existing compatibility integration suite.

---

### Task 1: Consolidate the legacy save-folder apply sequence

**Files:**
- Modify: `server/node/no-sqlite-runtime.test.ts`
- Modify: `server/node/server.cjs`

- [x] **Step 1: Write the failing duplication contract**

Limit the source inspection to the save-folder migration block and require the destructive preparation calls to appear only once:

```ts
const migrationBlock = server.slice(
    server.indexOf('// ── Save-folder migration endpoints'),
    server.indexOf('// ── Storage dashboard endpoints'),
)
expect(migrationBlock.match(/await flushPendingDb\(\)/g)).toHaveLength(1)
expect(migrationBlock.match(/createBackupAndRotate\(\)/g)).toHaveLength(1)
expect(migrationBlock.match(/invalidateDbCache\(\)/g)).toHaveLength(1)
expect(migrationBlock.match(/kvReplaceAll\(/g)).toHaveLength(1)
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts
```

Expected: FAIL because each operation currently appears twice in the migration block.

- [x] **Step 3: Extract the common apply helper**

Add the following helper and call it from both validated input paths:

```js
async function replaceWithLegacySaveEntries(entries) {
    await flushPendingDb();
    createBackupAndRotate();
    invalidateDbCache();
    kvReplaceAll(entries);
    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: entries.length };
}
```

Keep the directory-specific `Save folder does not contain database/database.bin` error and the upload-specific `Data does not contain database/database.bin` error unchanged. Do not change `kvReplaceAll`, canonical projection rebuilding, route names, response bodies, or cleanup-marker behavior.

- [x] **Step 4: Run focused storage and compatibility tests**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/no-sqlite-runtime.test.ts server/node/file-kv.test.ts server/node/legacy-sqlite-import.test.ts server/node/db-cache-recovery.test.ts
Remove-Item Env:RISUBARD_DATA_ROOT -ErrorAction SilentlyContinue; pnpm test:compat
```

Expected: storage tests pass; CHARX, module, plugin, backup, and save-folder compatibility tests pass with only existing environment-dependent skips.

- [x] **Step 5: Verify the diff, commit, and push**

```powershell
git diff --check
git add docs/superpowers/plans/2026-08-20-consolidate-save-folder-import.md server/node/no-sqlite-runtime.test.ts server/node/server.cjs
git commit -m "refactor: consolidate save-folder import apply path"
```
