# Release Gate Cleanup Implementation Plan

**Goal:** Make the refactor branch pass every pull-request release gate and ensure redistributed archives carry the inherited GPL notice.

**Scope:** Repair only confirmed gate failures. Preserve storage formats, CHARX, modules, plugins, and import/export behavior.

## Task 1: Repair stale frontend tests

- Update `CharConfigNavigation.test.ts` to recognize the current chat section's stable data attribute.
- Update `LoreBookWorkspace.test.ts` to verify the extracted built-in palette and its resolver wiring.
- Complete the `globalApi.svelte` mock used by `RisuBardSaveSlotsDialog.test.ts` with the imported asset-saving symbol.
- Run the three affected test files.

## Task 2: Clear type and accessibility checks

- Give the narrative term match result an explicit `string[]` type before filtering.
- Replace the two clickable chat-input `div` elements with labelled native buttons.
- Run `pnpm check` and the narrative-index tests.

## Task 3: Protect release licensing metadata

- Add a source-contract test that requires the package license identifier and both legal files in the release artifact.
- Confirm the new test fails first.
- Add `GPL-3.0-only` metadata and package `LICENSE` plus `NOTICE.md` in the release workflow.
- Re-run the release contract test.

## Task 4: Verify and publish the cleanup

- Run `pnpm check`, `pnpm build`, `pnpm test`, and `pnpm test:compat`.
- Run the public/brand/help/theme boundary checks if defined.
- Run `git diff --check`, review the final diff, commit, and push the refactor branch.
