# File-Native User Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite and the monolithic runtime database blob as user-data authorities with crash-safe, lazy, file-native repositories while preserving RisuAI import/export and public API compatibility.

**Architecture:** The Node server owns a configurable data root. Canonical JSON/JSONL/Markdown and content-addressed assets are committed through one atomic file primitive with revision backups, checksums, a small transaction journal, and boot recovery. A compatibility projection reconstructs the legacy `Database` object and `.bin` only at API/export boundaries; indexes and search catalogs are disposable derivatives.

**Tech Stack:** Node.js 24 built-ins (`fs`, `crypto`, streams), TypeScript/Svelte 5, Vitest, existing RisuSave codecs.

---

## File map

- `server/node/file-store.cjs`: atomic write, checksum envelope, parent fsync, revision backup, transaction journal, trash, recovery.
- `server/node/data-root.cjs`: `RISUBARD_DATA_ROOT` resolution and Windows/Termux-safe defaults.
- `server/node/file-kv.cjs`: compatibility KV projection over canonical files and content-addressed blobs.
- `server/node/user-data-repository.cjs`: stable-ID settings, secrets, presets, modules, personas, lorebooks, characters and chat metadata/message JSONL.
- `server/node/logs.cjs`, `request-logs.cjs`, `model-jobs.cjs`: rotating JSONL and per-job state/event files.
- `server/node/db.cjs`, `server.cjs`: legacy import/export adapter and HTTP compatibility wiring; no SQLite runtime.
- `src/ts/storage/database.svelte.ts`, `chatStorage.ts`: lazy index and explicit repository save/load boundary.
- `server/node/file-store.test.ts`, `user-data-repository.test.ts`, existing log/job/compat tests: crash, lazy-load, migration, backup and recovery proof.
- `docs/*/termux.md`, `docs/en/file-native-storage.md`, `docs/ko/file-native-storage.md`: data-root, migration, backup and Termux guidance.
- `project_wiki/file_native_user_data_architecture.md`, `index.md`, `decision_log.md`, `project_roadmap.md`: reviewed project contract.

### Task 1: Crash-safe file primitive and configurable root

- [ ] Write tests that demand: custom root resolution; temp + file fsync + rename + directory fsync; checksum rejection; `.bak` retention; transaction replay/rollback; trash instead of unlink.
- [ ] Run `npx vitest run --config vitest.config.server.ts server/node/file-store.test.ts` and confirm failures are missing-module/API failures.
- [ ] Implement `resolveDataRoot({ env, cwd, platform })`, `atomicWriteFile`, `atomicWriteJson`, `readVerifiedJson`, `commitTransaction`, `recoverTransactions`, and `moveToTrash` using stable relative paths and SHA-256.
- [ ] Re-run the targeted test to green.

### Task 2: File KV compatibility and legacy SQLite one-shot migration

- [ ] Write tests for binary round-trip, prefix listing/deletion, copy-on-snapshot, old hex save-folder import, manifest-only startup, and optional `risuai.db` extraction without a permanent native dependency.
- [ ] Run the new tests and confirm RED.
- [ ] Replace `db.cjs` with `file-kv.cjs` backed by `kv/manifest.json`, `kv/objects/<sha256>`, and canonical paths; expose the current KV API without a SQL handle.
- [ ] Add a one-shot migration command that dynamically loads an explicitly supplied SQLite reader only during import, backs up the source, and writes canonical files; normal startup must not load it.
- [ ] Re-run KV and compatibility tests.

### Task 3: Canonical entity tree and lazy projection

- [ ] Write repository tests that assert the exact tree: split settings/secrets; stable-ID preset/module/persona/lore JSON; character metadata directories; chat metadata plus appendable message JSONL; manifest-only boot; lazy character/chat body reads.
- [ ] Confirm RED.
- [ ] Implement repository methods `loadSidebarIndex`, `loadCharacter`, `loadChat`, `saveSettings`, `saveEntity`, `commitUserMessage`, `saveAssistantDraft`, `finalizeAssistantDraft`, `deleteToTrash`, `rebuildIndex`, `importLegacyDatabase`, and `exportLegacyDatabase`.
- [ ] Integrate the existing `chatStorage` hydration API with repository endpoints while retaining current client/plugin shapes.
- [ ] Confirm repository and chat tests GREEN.

### Task 4: JSONL logs, usage and durable model jobs

- [ ] Change existing tests to require `.jsonl` rotation and `model-jobs/<id>/state.json`, `events.jsonl`, `response.journal`; assert no `.db` files and crash recovery from `running` to `failed`.
- [ ] Run log/request-log/model-job tests and confirm RED.
- [ ] Preserve normalization/filtering/public route contracts while replacing SQL queries with bounded JSONL scans and in-memory grouping; use atomic state writes and append+fsync event records.
- [ ] Re-run targeted tests to GREEN.

### Task 5: Server integration, import/export and backup tree

- [ ] Add failing compatibility tests for server startup with no SQLite module, custom data root, `.bin` import to canonical tree, legacy `.bin` reconstruction, save-folder merge/replace with pre-backup, and full tree backup/restore including BardWiki.
- [ ] Confirm RED.
- [ ] Remove SQL transactions/stats/VACUUM/chunk calls from `server.cjs`; use file transactions and repository stats. Keep response fields compatible while reporting file-store values.
- [ ] Make backup manifests enumerate canonical roots, hashes and revisions; stage restore, validate all entries, atomically publish, and preserve the pre-restore tree in trash/backups.
- [ ] Confirm compat tests GREEN.

### Task 6: Remove native SQLite dependency and update UI/docs

- [ ] Remove `better-sqlite3`, SQLite build steps, `chunkStore.cjs`, and obsolete SQLite tests; add a source scan test that rejects runtime SQLite imports and `.db` creation.
- [ ] Update the storage dashboard terminology and fields to file store, revisions, trash and reclaimable content objects.
- [ ] Document Windows data-root selection and Termux internal-app storage; explicitly reject shared `/sdcard` as canonical storage.
- [ ] Add the canonical project-wiki decision and link it from index/decision log/roadmap.
- [ ] Run source scan, Svelte check, server tests and compatibility tests.

### Task 7: Final verification and private overlay synchronization

- [ ] Run `npm test`, `npm run check`, `npm run build`, and `npm run test:compat`; record exact pass/fail evidence.
- [ ] Review `git diff --check`, the complete public diff, and each acceptance criterion; fix only demonstrated gaps with a RED-GREEN cycle.
- [ ] Use `C:\Users\jsthe\.codex\skills\risubard-version-sync\SKILL.md` to merge public into private without pushing.
- [ ] Run the private repository's targeted/full verification required by the sync skill and confirm no private push occurred.

