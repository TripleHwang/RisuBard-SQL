# Arca-Compatible Message Copy Implementation Plan

> Execute this plan in the current `development` checkout. Do not create a worktree, commit, or touch unrelated dirty files.

**Goal:** Add an `아카라이브용 복사` action that copies one rendered RisuBard message as Arca-compatible rich HTML, preserving inline styling and turning CSS background assets into real clipboard images.

**Architecture:** Export from the live rendered message DOM so character-authored class CSS is available through computed styles. A standalone converter clones the content, materializes image backgrounds as `<img>` data URLs, inlines an Arca allowlist of CSS, rewrites unsupported horizontal flex layout to table/table-cell, and strips unsupported or interactive markup. `Chat.svelte` wraps the converted body in a safe header and writes both `text/html` and `text/plain` clipboard flavors.

**Tech Stack:** TypeScript, DOM APIs, Svelte 5, Vitest with happy-dom.

---

### Task 1: Build the Arca DOM exporter test-first

**Files:**
- Create: `src/ts/arcaExport.test.ts`
- Create: `src/ts/arcaExport.ts`

1. Add failing tests for background-image conversion and ordering.
2. Implement the minimum conversion needed to pass.
3. Add failing tests for computed-style inlining, forbidden CSS removal, and flex-to-table rewriting.
4. Implement the CSS allowlist and layout rewrite.
5. Add failing tests for existing `<img>` conversion and interactive-node removal, then implement them.

### Task 2: Connect the exporter to each chat message

**Files:**
- Modify: `src/lib/ChatScreens/Chat.svelte`
- Create: `src/lib/ChatScreens/ArcaCopyIntegration.test.ts`

1. Add a failing connection test for the new action and exporter call.
2. Add an `아카라이브용 복사` button beside the existing copy action.
3. Build an Arca-safe header/body wrapper without custom classes or unsupported CSS.
4. Write `text/html` and readable `text/plain` clipboard formats and report success/failure through existing notifications.

### Task 3: Verify the changed surface

1. Run the focused exporter and integration tests.
2. Run `svelte-check` and inspect only new diagnostics attributable to this change.
3. Run `git diff --check`, review the scoped diff, and confirm unrelated dirty files remain untouched.
