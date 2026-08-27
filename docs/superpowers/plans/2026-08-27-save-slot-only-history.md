# Save-Slot-Only BardWiki History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make save/load slots the only durable BardWiki rewind boundary, prevent destructive history edits that cannot safely rewind the wiki, and eliminate accumulating per-turn full snapshots.

**Architecture:** Chat receipts retain compact provenance metadata only. Ordinary turns write the wiki without durable pre-turn snapshots or undo endpoints. Message deletion and historical branching are rejected when they would invalidate BardWiki evidence, while cloning the current head remains available. Wiki Reboot may use one bounded in-flight recovery checkpoint, which is removed after completion. Legacy `.risubard-snapshots` directories are excluded from copies and cleaned during workspace migration.

**Tech Stack:** TypeScript, Svelte, Node.js filesystem services, Vitest

---

## Task 1: Enforce the chat-history policy in the UI

**Files:**
- Create: `src/ts/risubard/chatHistoryPolicy.ts`
- Create: `src/ts/risubard/chatHistoryPolicy.test.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] Write focused tests proving that receipt source messages are protected from single/cascade deletion, unrelated messages remain deletable, and only the current head is branchable.
- [ ] Run the focused tests and confirm they fail for the missing policy.
- [ ] Implement pure policy helpers based on `risubardCanonicalReceipt.sourceMessageIds`.
- [ ] Guard message deletion before any event retraction or array mutation and show a warning directing the user to save/load; mention Wiki Reboot for already inconsistent chats.
- [ ] Reject historical branch attempts with the same save/load guidance, while preserving current-head copy behavior.
- [ ] Run the focused tests and relevant Svelte/component tests.

## Task 2: Replace durable per-turn snapshots with compact receipts

**Files:**
- Modify: `src/ts/risubard/memoryWiki.ts`
- Modify: `src/ts/risubard/memoryWiki.test.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `server/node/risubard-memory-runtime.cjs`
- Modify: `server/node/risubard-memory-runtime.test.ts`
- Modify: `src/lib/ChatScreens/RisuBardTurnReceipt.svelte`
- Modify: `src/lib/ChatScreens/RisuBardTurnReceipt.test.ts`
- Modify: `src/lib/ChatScreens/Chats.svelte`
- Modify: `src/ts/process/index.svelte.ts`

- [ ] Update tests to require compact receipt metadata without `snapshotId`, before-state hashes, undo flags, or undo actions.
- [ ] Run focused receipt/analysis tests and confirm the expected failures.
- [ ] Construct receipts directly from the documents loaded before the write and the documents saved by the analysis runner.
- [ ] Remove ordinary-turn snapshot, receipt-persistence, and undo calls from client/server interfaces and routes.
- [ ] Convert the receipt component to a read-only provenance/status display and remove undo wiring.
- [ ] Run focused server and client tests.

## Task 3: Bound reboot recovery and disable snapshot-based historical forks

**Files:**
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-memory-fork.ts`
- Modify: `server/node/risubard-memory-fork.test.ts`
- Modify: `server/node/risubard-memory-save.ts`
- Modify: `server/node/risubard-memory-save.test.ts`
- Modify: `src/ts/risubard/wikiRebootTransport.ts`
- Modify: `src/ts/risubard/wikiRebootTransport.test.ts`
- Modify: `src/ts/risubard/wikiReboot.test.ts`

- [ ] Write tests proving ordinary turns create no snapshot directories, save/copy excludes legacy snapshots, historical branch requests fail, and current-head copy succeeds.
- [ ] Write reboot tests proving at most one in-flight recovery checkpoint exists and is removed after a completed/persisted batch.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Replace accumulating turn snapshots with a single reboot-only recovery location and explicit completion cleanup.
- [ ] Make recovery roll back and retry an incomplete batch rather than expose durable per-turn undo.
- [ ] Reject snapshot-based historical branches in the server even if an older client attempts one; permit a full current-head copy.
- [ ] Exclude and clean legacy `.risubard-snapshots` data during workspace access/copy migration.
- [ ] Run focused fork, save, reboot, and markdown-wiki tests.

## Task 4: Update the official contract and verify the migration

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/decision_log.md`
- Modify: affected architecture/user documentation discovered by exact reference search

- [ ] Replace the per-turn snapshot/undo contract with the save-slot-only rewind policy.
- [ ] Document deletion protection, historical-branch rejection, current-head copy, legacy cleanup, and bounded reboot recovery.
- [ ] Search for stale claims about `.risubard-snapshots`, per-turn undo, and historical branch reconstruction and update only authoritative affected documents.
- [ ] Run `git diff --check`, targeted Vitest suites, and the smallest relevant type/build validation.
- [ ] Inspect the final diff for unrelated changes and preserve the pre-existing untracked plan file.
