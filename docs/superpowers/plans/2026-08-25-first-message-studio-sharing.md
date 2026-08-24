# First Message Studio Sharing Implementation Plan

**Goal:** Preserve editable Studio source in Risu extensions while compiling an ordinary Risu-compatible first message, variables, and triggers into the same character card, with project JSON import/export in a new Share tab.

**Architecture:** Extend the Studio project with its completion-message source and a compatibility toggle. A pure compiler emits managed first-message markup, trigger scripts, and default variables; save merges only Studio-owned generated entries into the character. A versioned JSON envelope handles portable Studio projects.

**Tech Stack:** TypeScript, Svelte 5, Vitest, existing Risu CBS/trigger/card serialization.

### Task 1: Portable source and compatibility compiler

- Add failing unit tests for project envelope round-trip, invalid imports, generated first message, localized effects, input triggers, and managed merge behavior.
- Implement project schema normalization, import/export, compiler, and merge helpers.
- Run the focused TypeScript tests.

### Task 2: Share UI and save synchronization

- Add failing component tests for the Share tab, export/import controls, completion-message source, and compatibility synchronization on save.
- Add the Share primary tab and JSON file actions.
- Compile compatible fields during save while retaining editable source in `extensions.risuai.firstMessageStudio`.
- Run the focused editor tests.

### Task 3: Card serialization and verification

- Ensure V2 cards include Risu default variables as V3 already does.
- Add/adjust focused serialization coverage if available.
- Run affected tests, Svelte check, and production build.
