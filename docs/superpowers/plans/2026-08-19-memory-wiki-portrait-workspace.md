# Memory Wiki Portrait Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RisuBard Memory Wiki comfortable in portrait view with independently collapsible document, editor, and command panels, touch resizing, and an editor focus mode.

**Architecture:** Keep the current desktop and landscape DOM and sizing behavior. Add stateful panel controls to the existing Svelte components, then apply their collapsed/focus layout only under `@media (orientation: portrait)` so orientation—not a fixed width—selects the compact interaction model.

**Tech Stack:** Svelte 5, TypeScript, scoped CSS, Vitest, happy-dom

---

### Task 1: Lock the portrait interaction contract

**Files:**
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`
- Modify: `src/ts/risubard/memoryWikiLayout.test.ts`

- [x] **Step 1: Write the failing editor panel test**

Mount `RisuBardWikiEditor`, click `[data-wiki-toggle-tree]` and `[data-wiki-editor-focus]`, and assert that `data-tree-expanded`, `data-editor-expanded`, and `data-editor-focus` expose the new state. Dispatch `ArrowDown` to `[data-wiki-tree-resizer]` and assert that `--wiki-tree-height` increases.

- [x] **Step 2: Write the failing workspace integration test**

Mount `RisuBardMemoryWiki` with `onExecuteWikiCommand`, assert that the portrait command panel starts collapsed, expand it with `[data-wiki-toggle-command]`, then enter focus mode through `[data-wiki-editor-focus]` and assert `data-editor-focus="true"` on the dock.

- [x] **Step 3: Write the failing tree-height normalization test**

Add expectations for `normalizeMemoryWikiTreeHeight`: default `176`, lower clamp `96`, and an upper clamp that leaves at least `192px` for the editor.

- [x] **Step 4: Run tests and verify RED**

Run: `npx vitest run src/lib/Others/RisuBardWikiEditor.test.ts src/lib/Others/RisuBardMemoryWiki.test.ts src/ts/risubard/memoryWikiLayout.test.ts`

Expected: FAIL because the new controls, data attributes, and tree-height normalizer do not exist.

### Task 2: Implement portrait panels and focus mode

**Files:**
- Modify: `src/ts/risubard/memoryWikiLayout.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`

- [x] **Step 1: Implement tree-height normalization**

Export `normalizeMemoryWikiTreeHeight(value, availableHeight)` using a `176px` default, `96px` minimum, and `availableHeight - 192px` maximum.

- [x] **Step 2: Add editor panel state and controls**

Add `treeExpanded`, `editorExpanded`, `editorFocus`, and `treeHeight` state. Render 44px portrait panel headers for documents and editor, a keyboard-accessible tree/editor resize separator, and a focus button in the editor toolbar. Selecting a document collapses the tree and opens the editor; leaving focus restores the prior panel states.

- [x] **Step 3: Add mobile action disclosure**

Keep Save and Focus visible. Place Copy, Revert, and Delete actions in an overflow details menu in portrait view while rendering them inline in landscape/desktop view.

- [x] **Step 4: Integrate command collapse and editor focus**

Add a portrait command header and collapsed state around `RisuBardWikiCommandTerminal`. When focus mode is active, hide dock chrome, the command pane, and both resizers so the editor owns the available dock area.

- [x] **Step 5: Add portrait-only layout styling**

Use `@media (orientation: portrait)` for stacked accordion behavior and `@media (orientation: landscape)` for the existing split behavior. Give touch targets at least 44px, use semantic theme tokens, enlarge invisible drag hit areas, and honor `prefers-reduced-motion`.

- [x] **Step 6: Run tests and verify GREEN**

Run: `npx vitest run src/lib/Others/RisuBardWikiEditor.test.ts src/lib/Others/RisuBardMemoryWiki.test.ts src/ts/risubard/memoryWikiLayout.test.ts`

Expected: PASS.

### Task 3: Verify behavior and integration

**Files:**
- Verify: `src/lib/Others/RisuBardWikiEditor.svelte`
- Verify: `src/lib/Others/RisuBardMemoryWiki.svelte`

- [x] **Step 1: Run the affected Memory Wiki suite**

Run: `npm run verify:risubard-memory-wiki`

Expected: PASS with no Memory Wiki regressions.

- [x] **Step 2: Run Svelte type checking**

Run: `npm run check`

Expected: zero new errors in the changed files.

- [x] **Step 3: Run a production build**

Run: `npm run build`

Expected: exit code 0.

- [x] **Step 4: Inspect the final diff**

Run: `git diff --check -- src/lib/Others/RisuBardMemoryWiki.svelte src/lib/Others/RisuBardWikiEditor.svelte src/lib/Others/RisuBardMemoryWiki.test.ts src/lib/Others/RisuBardWikiEditor.test.ts src/ts/risubard/memoryWikiLayout.ts src/ts/risubard/memoryWikiLayout.test.ts`

Expected: no whitespace errors and no unrelated file changes.
