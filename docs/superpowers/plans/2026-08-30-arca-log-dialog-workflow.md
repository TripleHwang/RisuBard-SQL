# Arca Log Dialog Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. This repository explicitly forbids creating an unrequested worktree, so execute on the current checkout.

**Goal:** Make Arca log message selection, sidebar layout, staged appearance settings, persisted dialog size, outside-click dismissal, and asynchronous message rendering reliable.

**Architecture:** Keep message filtering and render-readiness rules in `arcaChatLog.ts` as testable pure functions. Persist shared choices in the existing `Database` record, while keeping unapplied appearance edits local to `ArcaChatLogDialog.svelte`. Extend the existing resize handle with an optional completion callback so this dialog can persist its measured size without changing other consumers.

**Tech Stack:** Svelte 5, TypeScript, Vitest, existing `ShDialog`, `ManagerResizeHandles`, and `DBState` persistence.

---

### Task 1: Message selection and rendering regression coverage

**Files:**
- Modify: `src/ts/arcaChatLog.test.ts`
- Modify: `src/ts/arcaChatLog.ts`

- [ ] **Step 1: Write failing tests**

```ts
expect(selectArcaLogMessages(messages, { mode: 'all' }, { includeUserMessages: false })
    .every(item => item.message.role !== 'user')).toBe(true)
expect(hasVisibleArcaLogContent(metadataOnly)).toBe(false)
expect(hasVisibleArcaLogContent(renderedText)).toBe(true)
```

- [ ] **Step 2: Run RED verification**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatLog.test.ts`
Expected: FAIL because selection options and visible-content detection do not exist.

- [ ] **Step 3: Implement the pure behavior**

```ts
export interface ArcaLogSelectionOptions { includeUserMessages?: boolean }
export function hasVisibleArcaLogContent(root: HTMLElement): boolean {
    const text = (root.textContent ?? '').replace(/[\u180E\u200B-\u200D\u2060\uFEFF]/g, '').trim()
    return Boolean(text || root.querySelector('img,picture,video,audio,canvas,svg,table,[style*="background"]'))
}
```

Filter `role === 'user'` only when `includeUserMessages === false`, retaining the current default.

- [ ] **Step 4: Run GREEN verification**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatLog.test.ts`
Expected: PASS.

### Task 2: Persist new global choices and dialog dimensions

**Files:**
- Modify: `src/ts/arcaChatSaverSettings.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/lib/Setting/RisuBardModeSettings.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
expect(databaseSource).toContain('risuBardArcaChatIncludeUserMessages?: boolean')
expect(databaseSource).toContain('risuBardArcaChatDialogSize?:')
```

- [ ] **Step 2: Run RED verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/Setting/RisuBardModeSettings.test.ts`
Expected: FAIL on the two new fields.

- [ ] **Step 3: Add normalized database fields**

```ts
risuBardArcaChatIncludeUserMessages?: boolean
risuBardArcaChatDialogSize?: { width: number; height: number }
```

Default user-message inclusion to `true`; normalize optional dimensions to bounded integer values.

- [ ] **Step 4: Run GREEN verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/Setting/RisuBardModeSettings.test.ts`
Expected: PASS.

### Task 3: Resize persistence callback

**Files:**
- Modify: `src/lib/UI/GUI/ManagerResizeHandles.svelte`
- Modify: `src/lib/UI/GUI/ManagerResizeHandles.test.ts`

- [ ] **Step 1: Write a failing callback test**

Mount with `onResizeEnd`, perform a keyboard resize, and assert the callback receives the target element.

- [ ] **Step 2: Run RED verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/UI/GUI/ManagerResizeHandles.test.ts`
Expected: FAIL because the callback is not called.

- [ ] **Step 3: Wire the optional callback**

```svelte
let { target, centered = false, onResizeEnd } = $props()
use:resizeHandle={{ start: () => startResize(edge), reset: resetSize, end: () => target && onResizeEnd?.(target) }}
```

- [ ] **Step 4: Run GREEN verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/UI/GUI/ManagerResizeHandles.test.ts`
Expected: PASS.

### Task 4: Dialog interaction and layout

**Files:**
- Modify: `src/lib/ChatScreens/ArcaChatLogDialog.svelte`
- Modify: `src/lib/ChatScreens/ArcaChatLogDialog.test.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] **Step 1: Write failing source contract tests**

Assert the user-message toggle, collapsible sidebar controls, staged setting buttons, outside-click dismissal, persisted resize callback, absent step labels, and one-line preview heading.

- [ ] **Step 2: Run RED verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/ChatScreens/ArcaChatLogDialog.test.ts`
Expected: FAIL on the new controls.

- [ ] **Step 3: Implement the interaction model**

```ts
let includeUserMessages = $state(true)
let settingsDraft = $state({ fontSizePx: 18, paragraphSpacingPercent: 100, imageWidthPercent: 60, showProfileImages: true })
function applyAppearanceSettings() { /* normalize, persist to DBState, then regenerate */ }
function cancelAppearanceSettings() { /* restore draft from DBState without regeneration */ }
```

Use a three-column selection control, a mobile-sized sidebar toggle, `closeOnOutsideClick={true}`, a compact one-line preview header, and 20px section headings. Persist the measured dialog size from the resize completion callback.

- [ ] **Step 4: Fix render readiness at the source**

Use `hasVisibleArcaLogContent(body)` in `waitForRenderedBody`, so zero-width AI metadata cannot be mistaken for completed visible output.

- [ ] **Step 5: Run GREEN verification**

Run: `node node_modules/vitest/vitest.mjs run src/lib/ChatScreens/ArcaChatLogDialog.test.ts src/ts/arcaChatLog.test.ts`
Expected: PASS.

### Task 5: Final verification

**Files:**
- Verify all files above.

- [ ] **Step 1: Run affected tests**

Run: `node node_modules/vitest/vitest.mjs run src/lib/ChatScreens/ArcaChatLogDialog.test.ts src/lib/UI/GUI/ManagerResizeHandles.test.ts src/lib/Setting/RisuBardModeSettings.test.ts src/ts/arcaChatLog.test.ts src/ts/arcaExport.test.ts src/lib/UI/GUI/ThemeTokenContract.test.ts`
Expected: all tests pass.

- [ ] **Step 2: Run static diagnostics**

Run: `node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json`
Expected: 0 errors and 0 warnings.

- [ ] **Step 3: Validate the patch**

Run: `git diff --check`
Expected: exit code 0.

### Task 6: Page and turn range selection

**Files:**
- Modify: `src/ts/arcaChatLog.ts`
- Modify: `src/ts/arcaChatLog.test.ts`
- Modify: `src/lib/ChatScreens/ArcaChatLogDialog.svelte`
- Modify: `src/lib/ChatScreens/ArcaChatLogDialog.test.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] **Step 1: Write failing range and summary tests**

```ts
expect(selectArcaLogMessages(messages, { mode: 'page', start: 2, end: 2, pageSize: 2 }))
    .toMatchObject([{ message: { sourceIndex: 2 } }, { message: { sourceIndex: 3 } }])
expect(selectArcaLogMessages(messages, { mode: 'turn', start: 2, end: 2 }))
    .toMatchObject([{ message: { role: 'user' } }, { message: { role: 'char' } }])
expect(summarizeArcaLogMessages(messages)).toEqual({ characters: 12, images: 2 })
```

- [ ] **Step 2: Run RED verification**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatLog.test.ts`
Expected: FAIL because page/turn modes and summary calculation do not exist.

- [ ] **Step 3: Implement stable page and turn grouping**

```ts
export type ArcaLogRange =
    | { mode: 'all' }
    | { mode: 'page'; start: number; end: number; pageSize: number }
    | { mode: 'turn'; start: number; end: number }
```

Assign pages from `sourceIndex` before applying user-message exclusion. Start a new turn at the greeting and each subsequent user message; filter user messages after range selection so the toggle never renumbers pages or turns.

- [ ] **Step 4: Rebuild the selection layout**

Render `챗 전체 | 페이지 범위 | 턴 범위`, then a range row with start/end fields on the left and the user toggle on the right, followed by `총 n자, 이미지 n개`.

- [ ] **Step 5: Run GREEN verification**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatLog.test.ts src/lib/ChatScreens/ArcaChatLogDialog.test.ts`
Expected: PASS.
