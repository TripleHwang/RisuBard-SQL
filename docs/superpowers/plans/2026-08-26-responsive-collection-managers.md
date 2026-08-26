# Responsive Collection Managers Implementation Plan

> **For agentic workers:** Use test-driven implementation and focused non-overlapping work, followed by spec and quality review. Work in the existing public checkout; do not create worktrees or commit.

**Goal:** Enlarge the module, plugin, and prompt-preset managers by 30%, support narrow screens, and provide window and inter-pane resize handles.

**Architecture:** Preserve the inline settings managers and the existing preset popup. Reuse the existing pointer/keyboard `resizeHandle` action with a shared manager-window handle component. The shared collection list changes between horizontal and vertical panes according to its actual container width, without changing saved collection data.

**Tech Stack:** Svelte 5, CSS container queries, ResizeObserver, Vitest/happy-dom, existing ShDialog.

## 1. Window sizing and regression tests

- [x] Add `src/lib/UI/GUI/ManagerResizeHandles.test.ts` covering centered and inline resizing, viewport/parent clamping, pointer cancellation/teardown, keyboard arrows and Home/double-click reset. Test actual mounted handles with layout rectangles supplied by the DOM harness.
- [x] Run `pnpm exec vitest run src/lib/UI/GUI/ManagerResizeHandles.test.ts` and confirm missing controls fail.
- [x] Add `ManagerResizeHandles.svelte` with `target: HTMLElement | null` and `centered?: boolean`. Use `--manager-width` and `--manager-height`; centered deltas multiply by two. Inline handles use east/south/southeast, dialog handles all eight edges/corners. Use existing theme tokens and accessible labels.
- [x] Extend `SettingPage.svelte` with opt-in `resizable`; multiply the previous body width (`--settings-content-width` minus both `--settings-page-gutter` values) by 1.3, with viewport/parent bounds and a flexible body. Only module/plugin managers opt in. Keep other settings unchanged.
- [x] Let only those two settings routes use the available settings content width when the resizable list is present, preserving module editing width and shared page/header structure. Preset popup moves to ShDialog at `min(96vw, 83.2rem)` (64rem × 1.3), with the shared resize handles.

## 2. Shared pane layout

- [x] Extend `CollectionOrganizerList.test.ts` and add mounted layout tests for splitter drag, bounds, cancel, keyboard/reset and mobile vertical sizing. Assert no collection data is saved by resizing.
- [x] Confirm tests fail before replacing the fixed `md:grid-cols-[13rem_minmax(0,1fr)]` layout.
- [x] Add a named inline-size container and a three-track grid: folders / handle / items at 720px+, stacked folders / handle / items below 720px. Use independent `--collection-folder-width` and `--collection-folder-height` overrides. Bound both panes to usable minimums and keep each scrollable.
- [x] Make search, bulk actions, folder controls and item controls wrap inside their own available width. Keep long labels from pushing actions outside the panel.
- [x] Add localized resize label and keyboard/reset hint to `src/lang/en.ts` and `src/lang/ko.ts`.

## 3. Manager content integration

- [x] Module/plugin item headers wrap their actions and long names without changing handlers, collection IDs, save behavior or plugin arguments. Use the shared resizable SettingPage only on the module list (not module editing) and plugin manager.
- [x] Preset item content puts long names/edit fields and action groups into bounded, wrapping areas. Preserve callbacks, active selections, copy/import/export and diff behavior. Keep the comparison overlay inside the dialog focus scope.
- [x] Run collection, manager, settings visual contract and theme-token tests; review spec compliance and then code quality.

## 4. Browser and handoff

- [x] Render real settings/managers at desktop and phone widths in an isolated in-memory local fixture. Check horizontal overflow, visible action controls and stacked panes. Verify keyboard window/pane resizing and reset in the browser; pointer bounds/cancel/reset are covered by mounted tests.
- [x] Run `pnpm check`, distinguishing the known unrelated `LoreBookWorkspace.test.ts` mock-union error, and build to validate CSS/container-query output.
- [x] Run `git diff --check`; stop the owned verification server and report the actual tested scope. Preserve all unrelated existing edits.

## Verification results

- Focused regression run: 9 test files, 54 tests passed.
- `pnpm build`: passed. Existing dependency/chunk-size warnings remain.
- `pnpm check`: one existing unrelated mock-union type error at `src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts:350`; zero warnings.
- Browser fixture: 1600px module body measured 1133.59px, exactly 1.3 times the previous 872px body; module/plugin/preset content showed no horizontal overflow at 320px. Preset content also passed at 390px. Both light and dark skins were exercised.
- Browser interaction: centered preset east handle changed width by 32px per arrow; folder splitter changed width by 16px. Home resets both. The comparison checkbox retained focus inside ShDialog.
- Spec and quality review complete; inline resize anchoring, module editor width isolation and comparison focus scope regressions corrected and tested.
- Owned Vite preview server on port 5174 (PID 24392) stopped; no user application data was changed by the fixture.
