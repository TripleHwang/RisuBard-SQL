# BARDCHAT Command Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the direct BardWiki terminal to BARDCHAT, add a two-pane command-template dialog with cursor insertion/replacement, and make multi-document combination safe and contract-driven.

**Architecture:** Keep templates in a small pure TypeScript catalog consumed by the existing Svelte terminal. Continue using the current structured direct-command pipeline; templates express machine-readable task labels, while the executor exposes the full wiki for cross-document work and never performs destructive cleanup after an earlier write failure.

**Tech Stack:** Svelte 5, TypeScript, Vitest, happy-dom, existing Lucide and ShButton components.

---

### Task 1: Command template catalog

**Files:**
- Create: `src/ts/risubard/bardChatCommandTemplates.ts`
- Create: `src/ts/risubard/bardChatCommandTemplates.test.ts`

- [ ] **Step 1: Write the failing catalog test**

Assert that the exported catalog has unique IDs, includes `combine`, `expand`, `shorten`, `summarize`, `reconnect`, and `networking`, and that `combine` tells the model to retain one survivor, preserve facts, reconnect links, and trash merged duplicates last.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ts/risubard/bardChatCommandTemplates.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the catalog**

Export `BardChatCommandTemplate` and `BARDCHAT_COMMAND_TEMPLATES` with Korean labels/descriptions and contract-shaped prompts for combine, split, expand, shorten, summarize, reconnect, networking, deduplicate, reconcile, normalize, rename, reclassify, extract, and timeline.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ts/risubard/bardChatCommandTemplates.test.ts`
Expected: PASS.

### Task 2: Two-pane BARDCHAT template dialog

**Files:**
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.test.ts`
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`

- [ ] **Step 1: Write failing component tests**

Mount the terminal and assert the BARDCHAT title and right-side `명령어 리스트` button. Open the dialog, select `combine`, assert the left list and right prompt preview, then verify `삽입` replaces the current textarea selection while preserving surrounding text, `교체` replaces the whole textarea, and `닫기` closes without editing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/Others/RisuBardWikiCommandTerminal.test.ts`
Expected: FAIL because the title, dialog, and actions do not exist.

- [ ] **Step 3: Implement the dialog and rename**

Import the template catalog, preserve textarea selection before opening, render an accessible modal with list and preview panes, implement insertion and replacement helpers, restore focus after applying, and rename both expanded and collapsed terminal headers to `BARDCHAT - AI에게 지시를 내리세요`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/Others/RisuBardWikiCommandTerminal.test.ts src/lib/Others/RisuBardWikiCommandConnections.test.ts`
Expected: PASS.

### Task 3: Safe cross-document command execution

**Files:**
- Modify: `src/ts/risubard/directWikiCommand.test.ts`
- Modify: `src/ts/risubard/directWikiCommand.ts`

- [ ] **Step 1: Write failing executor tests**

Assert that tagged `COMBINE`, `RECONNECT`, and `NETWORKING` instructions expose all active documents even when named targets exist. Assert that when an earlier upsert fails, later safe upserts still run but trash/retract operations are reported as skipped and are not executed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ts/risubard/directWikiCommand.test.ts`
Expected: FAIL because named commands currently narrow documents and destructive operations continue after write failure.

- [ ] **Step 3: Implement minimal executor safeguards**

Recognize explicit task labels in the operator instruction, use all documents for cross-document tasks, add merge/link ordering instructions to the system contract, track prior failures, and reject subsequent trash/retract operations when any earlier operation failed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ts/risubard/directWikiCommand.test.ts`
Expected: PASS.

### Task 4: Canonical documentation and focused verification

**Files:**
- Modify: `../project_wiki/markdown_narrative_wiki.md`

- [ ] **Step 1: Document the BARDCHAT contract**

Record that templates are editable prompts, insertion uses the remembered selection, replacement replaces the whole instruction, combine retains one stable-ID survivor, reconnects direct links, and only then moves redundant non-event documents to recoverable trash.

- [ ] **Step 2: Run focused verification**

Run: `npx vitest run src/ts/risubard/bardChatCommandTemplates.test.ts src/ts/risubard/directWikiCommand.test.ts src/lib/Others/RisuBardWikiCommandTerminal.test.ts src/lib/Others/RisuBardWikiCommandConnections.test.ts`
Expected: all tests PASS.

- [ ] **Step 3: Check the diff**

Run: `git diff --check -- src/ts/risubard/bardChatCommandTemplates.ts src/ts/risubard/bardChatCommandTemplates.test.ts src/ts/risubard/directWikiCommand.ts src/ts/risubard/directWikiCommand.test.ts src/lib/Others/RisuBardWikiCommandTerminal.svelte src/lib/Others/RisuBardWikiCommandTerminal.test.ts src/lib/Others/RisuBardMemoryWiki.svelte`
Expected: no whitespace errors.
