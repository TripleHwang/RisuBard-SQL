# Arca Title Image and Semantic Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable title-image layouts and convert RisuBard dialogue, thought, sound-effect, and choice markers into Arca-safe inline formatting.

**Architecture:** Persist title-image visibility and layout as global RisuBard settings, then pass them into the existing clipboard wrapper builder. Semantic formatting is applied while cloning the rendered message DOM: known `regex-*` classes keep their computed appearance, while unstyled whole-block delimiters receive a small dark/light inline preset that does not rely on `<style>` tags or classes.

**Tech Stack:** TypeScript, Svelte 5, Vitest/jsdom, existing declarative settings renderer.

---

### Task 1: Global title-image settings

**Files:**
- Modify: `src/ts/arcaChatSaverSettings.ts`
- Modify: `src/ts/arcaChatSaverSettings.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Setting/RisuBardModeSettings.test.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`

- [ ] **Step 1: Write failing tests for defaults and normalization**

Add expectations for `DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE === true`, default style `oval`, and normalization to the union `'oval' | 'square' | 'thumbnail-title'`.

- [ ] **Step 2: Run the focused settings test and verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatSaverSettings.test.ts`

Expected: FAIL because the title-image exports do not exist.

- [ ] **Step 3: Implement the settings model and persistence**

Add:

```ts
export type ArcaChatTitleImageStyle = 'oval' | 'square' | 'thumbnail-title'
export const DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE = true
export const DEFAULT_ARCA_CHAT_TITLE_IMAGE_STYLE: ArcaChatTitleImageStyle = 'oval'
export function normalizeArcaChatShowTitleImage(value: unknown): boolean
export function normalizeArcaChatTitleImageStyle(value: unknown): ArcaChatTitleImageStyle
```

Persist `risuBardArcaChatShowTitleImage` and `risuBardArcaChatTitleImageStyle` in `Database` and normalize them in `setDatabase()`.

- [ ] **Step 4: Add common-settings controls and translations**

Add a checkbox for title-image visibility and a conditional select with values `oval`, `square`, and `thumbnail-title`. Explain that the option is global and that the compact layout places a thumbnail beside the title.

- [ ] **Step 5: Run focused settings tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatSaverSettings.test.ts src/lib/Setting/RisuBardModeSettings.test.ts`

Expected: all tests pass.

### Task 2: Title-image clipboard layouts

**Files:**
- Modify: `src/ts/arcaExport.ts`
- Modify: `src/ts/arcaExport.test.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`
- Modify: `src/lib/ChatScreens/ArcaCopyIntegration.test.ts`

- [ ] **Step 1: Write failing wrapper tests**

Test all four states: hidden, large oval, large square crop, and compact thumbnail-title header. Assert only inline/table-compatible HTML is emitted.

- [ ] **Step 2: Run the exporter test and verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaExport.test.ts`

Expected: FAIL because `showTitleImage` and `titleImageStyle` are not supported.

- [ ] **Step 3: Implement the three layouts**

Extend `ArcaClipboardHtmlOptions` with:

```ts
showTitleImage?: boolean
titleImageStyle?: ArcaChatTitleImageStyle
```

Render the oval as a centered responsive portrait, the square as a 320px `object-fit: cover` crop, and the compact version as a 64px thumbnail beside the title and badge using a table row. When hidden, render only the title and badge.

- [ ] **Step 4: Connect global settings to every chat action**

Pass both DB values from `Chat.svelte` into `buildArcaClipboardHtml()` and add source-level integration assertions.

- [ ] **Step 5: Run exporter and integration tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaExport.test.ts src/lib/ChatScreens/ArcaCopyIntegration.test.ts`

Expected: all tests pass.

### Task 3: Arca-safe semantic block formatting

**Files:**
- Create: `src/ts/arcaSemanticFormatting.ts`
- Create: `src/ts/arcaSemanticFormatting.test.ts`
- Modify: `src/ts/arcaExport.ts`
- Modify: `src/ts/arcaExport.test.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`

- [ ] **Step 1: Write failing semantic detection and styling tests**

Cover `regex-quote-block`, `regex-thought-block`, `regex-sound-block`, and `regex-choice-block`. Also cover whole-block raw markers: `§sound§`, double-quoted dialogue, and single-quoted thought. Raw sound delimiters must be removed; partial prose containing quotes must not be reformatted.

- [ ] **Step 2: Run semantic tests and verify RED**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaSemanticFormatting.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic inline presets**

Export a decorator that detects the source class or whole-block marker and writes Arca-safe inline styles. Use the supplied devil-module structure: colored text, faint background, left border for dialogue/thought, bordered italic badge for sound, and a restrained selectable card for explicit choice classes. Preserve computed colors when the external module already supplied them; use dark/light fallbacks otherwise.

- [ ] **Step 4: Apply formatting during DOM cloning**

Call the decorator after safe computed styles have been inlined and before top-level spacing is added. Pass a dark/light palette hint from `Chat.svelte`. Do not infer choices from ordinary numbered lists.

- [ ] **Step 5: Run semantic and exporter tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaSemanticFormatting.test.ts src/ts/arcaExport.test.ts`

Expected: all tests pass.

### Task 4: Final verification

**Files:**
- Verify all files above without unrelated edits.

- [ ] **Step 1: Run the full focused regression set**

Run: `node node_modules/vitest/vitest.mjs run src/ts/arcaChatSaverSettings.test.ts src/ts/arcaSemanticFormatting.test.ts src/ts/arcaExport.test.ts src/lib/ChatScreens/ArcaCopyIntegration.test.ts src/lib/Setting/RisuBardModeSettings.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Run Svelte diagnostics**

Run: `npx svelte-check --tsconfig ./tsconfig.json`

Expected: 0 errors and 0 warnings.

- [ ] **Step 3: Check the patch**

Run: `git diff --check`

Expected: exit code 0. Review only the Arca saver files and preserve all unrelated dirty files.
