# Lorebook Loremaster Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the native lorebook workspace into a selection-aware editor with explicit single/group drag-and-drop feedback and theme-token-driven hierarchy.

**Architecture:** Keep the existing `loreBook` model, immutable workspace operations, storage callbacks, and Sortable integration. Change only the workspace presentation and drag session state: one selected item shows the entry editor, multiple selected items show the batch editor in the right pane, and dragging a selected row moves the selected set in source order.

**Tech Stack:** Svelte 5, TypeScript, SortableJS, Vitest, Happy DOM, project `--color-*` theme tokens.

---

### Task 1: Lock selection-aware editor behavior

**Files:**
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts`
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte`

- [x] **Step 1: Write the failing test**

Add a component test that selects two normal entries and asserts that `[data-lorebook-batch]` is rendered inside `[data-lorebook-editor]`, not inside the list pane.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts`

Expected: FAIL because the current batch sheet is a floating child of the list pane.

- [x] **Step 3: Write minimal implementation**

Render the existing batch controls as the first branch of the right editor pane when `selectedIds.size > 1`. Keep the single-entry editor for zero or one selected item, and keep explicit movement controls available inside a collapsed action group.

- [x] **Step 4: Run test to verify it passes**

Run the same targeted Vitest command and expect the new test to pass.

### Task 2: Expose grouped drag-and-drop state

**Files:**
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts`
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte`

- [x] **Step 1: Write the failing test**

Add an integration test that selects non-adjacent entries, starts a drag from one selected row, verifies the selected rows are marked as one dragging group, drops before a target, and asserts that both selected entries move in source order.

- [x] **Step 2: Run test to verify it fails**

Run the workspace component test and expect failure because grouped drag and drop currently has no reactive drag-count or drop-position affordance.

- [x] **Step 3: Write minimal implementation**

Track `draggingIds` and a reactive `dropIntent`. Apply `data-lorebook-drag-count`, grouped-row classes, and before/after/inside drop-position attributes while continuing to call `moveLorebookEntries(entries, sourceIds, targetId, position)`.

- [x] **Step 4: Run test to verify it passes**

Run the workspace component test and verify both the visual state and immutable multi-row result.

### Task 3: Apply semantic hierarchy tokens and verify

**Files:**
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [x] **Step 1: Add semantic component tokens**

Define local variables such as `--lore-surface-root`, `--lore-surface-folder`, `--lore-surface-child`, `--lore-hierarchy-line`, `--lore-drop-target`, and `--lore-selection` from canonical `--color-*` tokens. Use them for folder surfaces, child indentation, selected rows, drag groups, and drop guides.

- [x] **Step 2: Add accessible localized drag guidance**

Add Korean and English strings explaining that dragging a selected row moves the whole selection and that the enabled switch replaces the former Loremaster hidden workaround.

- [x] **Step 3: Run targeted verification**

Run:

```text
pnpm vitest run src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts src/ts/lorebook/workspaceOperations.test.ts src/lang/lorebookLabels.test.ts
pnpm check:theme-tokens
```

Expected: all tests pass and the theme-token contract reports no invalid variables.
