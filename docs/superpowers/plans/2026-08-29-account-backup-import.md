# Risu Account Backup Import Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Import encrypted upstream Risu account backups and reject invalid backups without replacing the active database.

**Architecture:** Keep the existing streamed staging pipeline, but recognize `encryption.risudat` as metadata instead of an asset. Decrypt and decode the staged database before the manifest publish step; only validated bytes may enter the active KV revision.

**Tech Stack:** Node.js CommonJS server, Web-compatible AES-256-GCM, Vitest compatibility integration tests.

---

### Task 1: Add regression coverage

**Files:**
- Create: `test/compat/account-backup-import.test.ts`

**Step 1: Write failing tests**

- Build an upstream-style account backup containing `encryption.risudat` and AES-GCM encrypted `database.risudat`.
- Serve the account key from a local HTTP endpoint supplied through the spawned server environment.
- Assert the encrypted backup imports and re-exports as a valid database.
- Import a malformed database after valid data and assert the request fails while the valid data remains readable.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --config vitest.config.compat.ts test/compat/account-backup-import.test.ts`

Expected: encrypted import fails with `invalid block type`; malformed import leaves the active database broken.

### Task 2: Validate staged backups before publish

**Files:**
- Modify: `server/node/server.cjs`

**Step 1: Add account-backup metadata handling**

- Stage `encryption.risudat` separately and exclude it from imported assets.
- Fetch the matching key from the configurable account key endpoint.
- Decrypt the staged database with the upstream AES-GCM format.

**Step 2: Decode before publishing**

- Decode the final staged database bytes before `kvReplacePrefixesFromFilesAsync` changes the active manifest.
- Reject malformed metadata, decryption failures, and undecodable databases without mutating active data.

**Step 3: Run targeted tests**

Run: `pnpm vitest run --config vitest.config.compat.ts test/compat/account-backup-import.test.ts`

Expected: PASS.

### Task 3: Verify affected behavior

**Files:**
- Test: `test/compat/account-backup-import.test.ts`
- Test: `test/compat/backup-roundtrip.test.ts`

**Step 1: Run focused compatibility tests**

Run: `pnpm vitest run --config vitest.config.compat.ts test/compat/account-backup-import.test.ts test/compat/backup-roundtrip.test.ts`

Expected: PASS.

**Step 2: Check the patch**

Run: `git diff --check`

Expected: no whitespace errors.
