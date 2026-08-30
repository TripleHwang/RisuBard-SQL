# BARDCHAT Context Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact, per-chat BARDCHAT context checkboxes so the operator controls whether Wiki, recent chat, system prompt, character description, persona, character lorebook, and module lorebook are sent to the administrator model.

**Architecture:** Store seven optional booleans in `RisuBardChatSettings`, resolve safe defaults, and pass a typed selection from the dock terminal through the current-chat command callback. Build optional context sources at execution time, and let `directWikiCommand` serialize only selected non-empty sources into the bounded payload. Existing callers without a selection retain the prior current-message heuristic.

**Tech Stack:** Svelte 5, TypeScript, Vitest, existing Persona Builder source collectors.

---

### Task 1: Per-chat context contract

**Files:**
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Test: `src/ts/risubard/risuBardSettings.test.ts`

- [ ] **Step 1: Write the failing test** asserting defaults (`wiki: true`, all optional sources false), global inheritance, and chat override.
- [ ] **Step 2: Run** `npx vitest run src/ts/risubard/risuBardSettings.test.ts` and verify the new assertions fail because the fields do not exist.
- [ ] **Step 3: Add** the seven optional and resolved boolean fields, resolving only explicit `true` for optional sources and defaulting Wiki to enabled.
- [ ] **Step 4: Re-run the test** and verify it passes.

### Task 2: Bounded administrator payload

**Files:**
- Modify: `src/ts/risubard/directWikiCommand.ts`
- Test: `src/ts/risubard/directWikiCommand.test.ts`

- [ ] **Step 1: Write the failing test** with every source populated and only system prompt plus persona selected; assert documents, chat, and lorebooks are absent from the submitted JSON.
- [ ] **Step 2: Run** the direct command test and verify failure because no selection/source API exists.
- [ ] **Step 3: Add** `DirectWikiContextSelection` and `DirectWikiContextSources`; serialize only enabled sources and keep legacy behavior when selection is omitted.
- [ ] **Step 4: Re-run the test** and verify it passes with existing command tests.

### Task 3: Toolbar and persisted wiring

**Files:**
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/ts/process/index.svelte.ts`
- Test: `src/lib/Others/RisuBardWikiCommandTerminal.test.ts`
- Test: `src/lib/Others/RisuBardWikiCommandConnections.test.ts`

- [ ] **Step 1: Write the failing UI test** asserting seven header checkboxes, selection propagation on execute, and change persistence callback.
- [ ] **Step 2: Run** the two component tests and verify the toolbar/API assertions fail.
- [ ] **Step 3: Implement** the compact terminal-style checkbox strip and the typed two-argument execution callback.
- [ ] **Step 4: In the dock, derive selections from the current chat settings and persist changes directly to `chat.risuBardSettings`.**
- [ ] **Step 5: In the process path, reuse Persona Builder collectors, match the character lorebook only when selected, and pass only selected sources to `executeDirectWikiCommand`.**
- [ ] **Step 6: Re-run component and process connection tests** and verify they pass.

### Task 4: Documentation and verification

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`

- [ ] **Step 1: Document** per-chat persistence, defaults, source meanings, and the fact that unchecked material is neither loaded nor serialized.
- [ ] **Step 2: Run targeted client tests** for settings, terminal, connections, and direct command.
- [ ] **Step 3: Run** `git diff --check` on touched files and `npm run check`; distinguish unrelated pre-existing diagnostics from this change.
