# Archplotter Settings Implementation Plan

**Goal:** Add a one-column Archplotter settings section with immutable built-in presets and editable user presets, and apply the selected limits to the existing BardWiki story-arc writer without changing structured model output schemas.

**Architecture:** Keep preset/config normalization in a shared pure TypeScript module. The common settings page renders the Archplotter group in stacked layout while the rest of the page keeps its existing row layout. The analysis client sends one normalized `arcPlotterSettings` input object to the server; the server uses it only for checkpoint planning, prompt limits, and final Markdown length validation.

**Tech Stack:** Svelte 5, TypeScript, Vitest, existing BardWiki memory-analysis pipeline.

---

### Task 1: Lock the settings contract with tests

**Files:**
- Create: `src/ts/risubard/arcPlotterSettings.test.ts`
- Modify: `server/node/risubard-story-arc-writer.test.ts`
- Modify: `src/lib/Setting/RisuBardModeSettings.test.ts`

1. Test the three ordered built-in presets and the current medium-story defaults.
2. Test normalization, custom preset save/overwrite/delete, and built-in immutability.
3. Test configurable writer checkpoint size, prompt limits, the new Plot title, and legacy Map title recognition.
4. Run the focused tests and confirm they fail for missing behavior.

### Task 2: Implement shared settings and persistence

**Files:**
- Create: `src/ts/risubard/arcPlotterSettings.ts`
- Modify: `src/ts/storage/database.svelte.ts`

1. Define bounded settings, built-in presets, and normalized custom preset records.
2. Add database fields and load-time normalization.
3. Keep built-in IDs program-owned and reject overwrite/delete operations against them.

### Task 3: Add the one-column settings UI

**Files:**
- Create: `src/lib/Setting/Pages/RisuBardArcPlotterPresets.svelte`
- Modify: `src/ts/setting/customComponents.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Setting/Pages/RisuBardCommonSettings.svelte`
- Modify: `src/lib/Setting/Wrappers/SettingHeader.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

1. Insert Archplotter between BardWiki analysis and writing.
2. Put preset selection and CRUD first, with built-ins above a disabled divider.
3. Render all Archplotter controls in stacked layout and add title-level help.
4. Mark the active selection as unsaved custom whenever a limit is edited.

### Task 4: Connect settings to the writer

**Files:**
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `server/node/risubard-story-arc-writer.ts`
- Modify: related focused tests

1. Pass normalized settings in normal analysis and reboot analysis inputs.
2. Use the configured checkpoint and bullet/character limits in planning and prompts.
3. Keep the existing event excerpt hard cap and structured response schemas unchanged.
4. Generate `스토리 아크 플롯` / `Story Arc Plot`, while recognizing legacy Map documents.

### Task 5: Update contracts and verify

**Files:**
- Modify: `project_wiki/context_pipeline_architecture.md`
- Modify: `project_wiki/bounded_context_architecture.md`
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/inquiry_context_compiler.md`
- Modify: `project_wiki/decision_log.md`
- Modify: `patchnote/0.9.11.md`

1. Replace user-facing “map” terminology with “plot” and document configurable presets and safety bounds.
2. Run focused client/server tests, help-key validation, Svelte check, and diff checks.
