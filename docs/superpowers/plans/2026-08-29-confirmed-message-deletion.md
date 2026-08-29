# Confirmed Message Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow confirmed historical messages to be deleted while retracting related event documents, preserving non-event canonical documents, and warning that Wiki Reboot is required for an exact historical state.

**Architecture:** Keep historical branching blocked, but remove the deletion prohibition. The chat deletion flow sends every removed stable message ID to the existing source-based event retraction endpoint before mutating chat history; that endpoint continues to delete only active `event` documents, leaving character, location, item, and other canonical documents unchanged.

**Tech Stack:** TypeScript, Svelte 5, Node.js, Vitest

---

### Task 1: Define the deletion behavior with failing tests

**Files:**
- Modify: `src/ts/risubard/chatHistoryPolicy.test.ts`
- Modify: `src/lib/ChatScreens/RisuBardEventRetractionOnDelete.test.ts`
- Modify: `src/ts/risubard/memoryWiki.test.ts`

- [x] Replace deletion-blocking assertions with assertions that only historical branching remains protected.
- [x] Require the chat deletion flow to omit `deletionTouchesBardWikiEvidence`, show exact counts for both delete choices, collect every removed stable message ID, and retract events before mutating the message array.
- [x] Require source retraction transport to preserve more than 100 removed message IDs instead of silently truncating them.
- [x] Run `pnpm vitest run src/ts/risubard/chatHistoryPolicy.test.ts src/lib/ChatScreens/RisuBardEventRetractionOnDelete.test.ts src/ts/risubard/memoryWiki.test.ts` and verify failure comes from the old deletion block, confirmed-only ID filter, and 100-ID truncation.

### Task 2: Implement confirmed-message deletion

**Files:**
- Modify: `src/ts/risubard/chatHistoryPolicy.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`
- Modify: `src/ts/risubard/memoryWiki.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [x] Remove only the deletion-blocking helper and keep the existing historical-branch policy.
- [x] Put `(1개)` / `(1 message)` on single-delete actions and retain the exact cascade count.
- [x] Replace the blocking notice with a confirmation explanation: linked event summaries are deleted, other canonical documents are preserved rather than rolled back, and Wiki Reboot is required for an exact prior state.
- [x] Send all removed stable message IDs to `retractWikiEventsBySourceMessages` before chat mutation; abort chat deletion if event retraction fails.
- [x] Remove the client-side 100-ID truncation so every deleted message can participate in source matching.
- [x] Run the focused client tests and verify they pass.

### Task 3: Lock canonical preservation and update the official contract

**Files:**
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `../project_wiki/markdown_narrative_wiki.md`
- Modify: `../project_wiki/bounded_context_architecture.md`
- Modify: `../project_wiki/context_pipeline_architecture.md`
- Modify: `../project_wiki/decision_log.md`

- [x] Extend the source-retraction server test with a linked non-event canonical document and verify it remains active after its event is deleted.
- [x] Record the 2026-08-29 decision: explicit confirmed-message deletion is allowed; linked events are removed first; other canonical documents remain unchanged; exact consistency requires Wiki Reboot.
- [x] Remove stale official claims that ordinary turns retain durable snapshots, per-turn undo, or historical branching.
- [x] Run the focused server test and affected policy tests.

### Task 4: Verify the complete change

**Files:**
- Verify only the files listed above.

- [x] Run `pnpm vitest run src/ts/risubard/chatHistoryPolicy.test.ts src/lib/ChatScreens/RisuBardEventRetractionOnDelete.test.ts src/ts/risubard/memoryWiki.test.ts`.
- [x] Run `pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-wiki.test.ts server/node/risubard-memory-routes.test.ts`.
- [x] Run `git diff --check` and inspect the scoped diff without altering unrelated working-tree changes.
