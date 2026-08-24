# BardWiki Reboot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild a chat's BardWiki from its first accepted assistant turn in persistent, resumable one-turn or two-turn batches.

**Architecture:** Persist a bounded reboot job on the owning `Chat`, write every batch into a separate staging memory workspace, and atomically replace the live workspace only after all target turns finish. The existing Markdown analysis pipeline remains authoritative; a reboot-only two-turn schema preserves one event per assistant turn while sharing canonical analysis and rewrite work across the pair. A snapshot recovery endpoint distinguishes completed batch receipts from interrupted writes and restores only the incomplete batch before retry.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Express-compatible Node routes, filesystem-backed Markdown Wiki.

---

### Task 1: Persistent reboot domain model and activity state

**Files:**
- Create: `src/ts/risubard/wikiReboot.ts`
- Create: `src/ts/risubard/wikiReboot.test.ts`
- Create: `src/ts/risubard/wikiGenerationState.ts`
- Create: `src/ts/risubard/wikiGenerationState.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`

- [ ] **Step 1: Write failing tests** for active-message turn projection, stable one/two-turn batching, odd final batches, persisted status normalization, send blocking, and reference-counted Wiki generation activity.
- [ ] **Step 2: Run tests and verify RED** with missing module/API failures.
- [ ] **Step 3: Implement the minimal domain API**:

```ts
export type WikiRebootBatchSize = 1 | 2
export type WikiRebootStatus = 'running' | 'stop-requested' | 'paused' | 'failed' | 'finalizing'
export interface WikiRebootJob {
  version: 1
  jobId: string
  stagingChatId: string
  batchSize: WikiRebootBatchSize
  status: WikiRebootStatus
  targetAssistantMessageIds: string[]
  completedAssistantMessageIds: string[]
  receipts: Record<string, CanonicalTurnReceipt>
  startedAt: number
  updatedAt: number
  inFlightAssistantMessageIds?: string[]
  lastError?: string
}
export function projectWikiRebootTurns(messages: readonly Message[]): WikiRebootTurn[]
export function nextWikiRebootBatch(job: WikiRebootJob, turns: readonly WikiRebootTurn[]): WikiRebootTurn[]
export function blocksChatGeneration(job?: WikiRebootJob): boolean
```

Use a `Set<string>`-backed Svelte store for `beginWikiGeneration(operationId)` / `endWikiGeneration(operationId)` so concurrent Wiki work cannot stop the composer spinner early.

- [ ] **Step 4: Run tests and verify GREEN.**

### Task 2: Two-turn structured analysis and interrupted-batch recovery

**Files:**
- Modify: `server/node/risubard-memory-writer.ts`
- Modify: `server/node/risubard-memory-writer.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-markdown-wiki.test.ts`

- [ ] **Step 1: Write failing tests** proving that a two-turn batch accepts exactly two ordered source groups, produces two separately grounded event documents, performs one canonical batch rewrite, and records both events in one batch receipt.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Add a reboot batch schema and parser** whose shape is:

```ts
{
  schemaVersion: 1,
  turns: Array<{ assistantMessageId: string, title: string, establishedEvents: string[] }>,
  stateChanges: MemoryWriterDraft['stateChanges'],
  characterKnowledge: MemoryWriterDraft['characterKnowledge'],
  persistentFacts: string[],
  openContinuity: string[],
  canonicalUpdateCandidates: MemoryWriterDraft['canonicalUpdateCandidates']
}
```

Transform the aggregate fields into the existing canonical rewrite path and save each `turns[]` entry with only that turn's user/assistant source IDs.

- [ ] **Step 4: Add snapshot recovery** that returns an existing receipt when complete; otherwise restores canonical files from the pre-batch snapshot, removes documents created by the incomplete batch and its exact-source event files, rebuilds the generated index, and returns `null`.
- [ ] **Step 5: Run targeted tests and verify GREEN.**

### Task 3: Workspace replacement, cleanup, and client transport

**Files:**
- Modify: `server/node/risubard-memory-runtime.cjs`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `server/node/risubard-memory-runtime.test.ts`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `src/ts/risubard/memoryWikiFork.ts`
- Modify: `src/ts/risubard/memoryWikiFork.test.ts`
- Create: `src/ts/risubard/wikiRebootTransport.ts`
- Create: `src/ts/risubard/wikiRebootTransport.test.ts`

- [ ] **Step 1: Write failing transport and route tests** for authenticated replacement preparation, idempotent finalize/discard, reboot staging cleanup, and snapshot recovery.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Expose serialized runtime operations**:

```ts
replaceMemory(input) // replaceMemoryWorkspace(source staging -> live)
removeRebootMemory(input) // only accepts staging IDs prefixed `reboot-`
recoverWikiRebootBatch(input) // receipt-or-rollback
```

Validate exact request keys and bounded IDs on every route. Invalidate the Markdown catalog cache after replacement, cleanup, or recovery.

- [ ] **Step 4: Add browser clients** that validate every response before returning.
- [ ] **Step 5: Run targeted tests and verify GREEN.**

### Task 4: Reboot orchestration and chat-generation lock

**Files:**
- Modify: `src/ts/process/index.svelte.ts`
- Create: `src/ts/risubard/wikiRebootRunner.test.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Create: `src/lib/ChatScreens/RisuBardWikiRebootConnections.test.ts`

- [ ] **Step 1: Write failing tests** for starting against a fixed target boundary, saving `inFlightAssistantMessageIds` before a model call, checkpointing after success, safe stop after the current batch, resume after recovery, final atomic publish, cancellation cleanup, and blocking send/reroll/continue while any reboot job is incomplete.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Implement orchestration exports**:

```ts
startCurrentWikiReboot(batchSize: 1 | 2): Promise<void>
requestCurrentWikiRebootStop(): Promise<void>
resumeCurrentWikiReboot(): Promise<void>
cancelCurrentWikiReboot(): Promise<void>
```

Use the original chat ID for model binding/logging and the staging chat ID for Wiki persistence. Persist the chat immediately before and after each batch. On success, apply stored receipts to the corresponding assistant messages, atomically publish staging, clear the job, and announce the Wiki update.

- [ ] **Step 4: Guard every response-generation entry point** while `blocksChatGeneration(currentChat.risuBardWikiReboot)` is true. Keep the draft editable but disable Send and prevent Enter/reroll/continue paths.
- [ ] **Step 5: Run tests and verify GREEN.**

### Task 5: Toolbar control, two-step selection dialog, and shared spinner

**Files:**
- Create: `src/lib/Others/RisuBardWikiRebootDialog.svelte`
- Create: `src/lib/Others/RisuBardWikiRebootDialog.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] **Step 1: Write failing component tests** for the text toolbar states (`위키 리부트`, `리부트 정지`, `리부트 계속`, `정지 대기 중…`, `마무리 중…`), first destructive confirmation, centered side-by-side square one/two-turn choices with keyboard-accessible tooltips, cancel action, progress copy, and spinner state on the composer BardWiki button.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Implement the restrained ledger-style dialog** using existing theme tokens and `ShDialog`. Keep the core tradeoff visible on each square and put detailed pros/cons in `title` plus focusable descriptive text. Selection starts immediately after the first warning; the second screen's `취소` changes nothing.
- [ ] **Step 4: Wire the shared Wiki activity store** into automatic confirmation, additional analysis, direct Wiki command, and reboot batches. Rotate the composer `BookOpenIcon` whenever the set is non-empty.
- [ ] **Step 5: Run component tests and verify GREEN.**

### Task 6: Targeted verification and contract documentation

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/context_pipeline_architecture.md`

- [ ] **Step 1: Update the canonical contract** with staging rebuild, selectable one/two-turn batches, per-turn events, batch-level canonical receipts, persistent safe-stop/resume, incomplete-batch recovery, and generation locking.
- [ ] **Step 2: Run focused client and server tests** for all changed modules.
- [ ] **Step 3: Run `pnpm check`** and inspect all diagnostics.
- [ ] **Step 4: Run `git diff --check` and `git status --short`**, preserving unrelated user changes.

## Self-review

- Spec coverage: toolbar text states, two confirmations, side-by-side mode selection, tooltips, cancellation, persistent stop/resume, crash recovery, shared spinner, one/two-turn mode, and response-generation blocking are each mapped above.
- Placeholder scan: no TBD/TODO/"implement later" placeholders remain.
- Type consistency: `WikiRebootJob`, `WikiRebootBatchSize`, source groups, receipts, and staging IDs use the same names through domain, transport, process, and UI tasks.
