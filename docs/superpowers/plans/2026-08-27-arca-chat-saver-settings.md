# Arca Chat Saver Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the Arca copy action to “아카라이브 챗 저장기”, add global image-width and font-size settings under RisuBard Common Settings, and make exported frames fill the available Arca editor width.

**Architecture:** Store two normalized optional fields on the global `Database`, expose them through the existing data-driven RisuBard common-settings page, and read them at click time in every `Chat.svelte` instance. Pass image width into the DOM exporter and font size into the clipboard wrapper builder; remove the hard-coded 600px outer-frame maximum so a block frame naturally fills its containing editor.

**Tech Stack:** TypeScript, Svelte 5, existing SettingRenderer/Database persistence, Vitest with happy-dom.

---

### Task 1: Define and persist global saver settings

**Files:**
- Create: `src/ts/arcaChatSaverSettings.ts`
- Create: `src/ts/arcaChatSaverSettings.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`

- [ ] **Step 1: Write failing normalizer tests**

Test defaults and bounds through the public functions:

```ts
expect(normalizeArcaImageWidthPercent(undefined)).toBe(60)
expect(normalizeArcaFontSizePx(undefined)).toBe(18)
expect(normalizeArcaImageWidthPercent(200)).toBe(100)
expect(normalizeArcaFontSizePx(2)).toBe(10)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `node node_modules/vitest/vitest.mjs run src/ts/arcaChatSaverSettings.test.ts` and expect the missing-module/API failure.

- [ ] **Step 3: Implement constants and normalization**

Create numeric normalizers with defaults `60` and `18`, image range `10..100`, and font range `10..32`. Add optional `risuBardArcaChatImageWidthPercent` and `risuBardArcaChatFontSizePx` fields to `Database`, then normalize both in `setDatabase`.

- [ ] **Step 4: Re-run and verify GREEN**

Run the same focused test and expect all assertions to pass.

### Task 2: Add the common-settings section

**Files:**
- Modify: `src/lib/Setting/RisuBardModeSettings.test.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`

- [ ] **Step 1: Extend the connection test first**

Assert that the common settings data includes the `아카라이브 챗 추출기` header and number controls bound to both new global DB keys with `10..100` and `10..32` limits.

- [ ] **Step 2: Run the test and verify RED**

Run `node node_modules/vitest/vitest.mjs run src/lib/Setting/RisuBardModeSettings.test.ts` and expect missing binding failures.

- [ ] **Step 3: Add the header, controls, labels, and help text**

Append one `header` item followed by two `number` items to `risuBardCommonSettingsItems`. Use Korean labels `아카라이브 챗 추출기`, `추출 시 이미지 너비 (%)`, and `폰트 크기 (px)` with English fallbacks and concise help explaining global application.

- [ ] **Step 4: Re-run and verify GREEN**

Run the same settings test and expect it to pass.

### Task 3: Apply dimensions and fill the Arca frame

**Files:**
- Modify: `src/ts/arcaExport.test.ts`
- Modify: `src/ts/arcaExport.ts`

- [ ] **Step 1: Write failing exporter tests**

Assert that `imageWidthPercent: 60` creates image CSS with `width: 60%`, `fontSizePx: 18` sets the wrapper base font size, and the wrapper no longer contains `max-width: 600px` or auto-centering horizontal margins.

- [ ] **Step 2: Run the exporter test and verify RED**

Run `node node_modules/vitest/vitest.mjs run src/ts/arcaExport.test.ts` and expect the new assertions to fail.

- [ ] **Step 3: Implement the responsive export options**

Normalize and apply `imageWidthPercent` to every materialized image. Normalize and apply `fontSizePx` to the outer clipboard frame. Replace the outer `max-width: 600px; margin: 1rem auto` with a natural full-width block using `margin: 1rem 0`.

- [ ] **Step 4: Re-run and verify GREEN**

Run the exporter test and expect all cases to pass.

### Task 4: Rename and connect every chat action

**Files:**
- Modify: `src/lib/ChatScreens/ArcaCopyIntegration.test.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] **Step 1: Add failing global-connection assertions**

Assert that `Chat.svelte` passes `DBState.db.risuBardArcaChatImageWidthPercent` to `exportArcaHtml`, passes `DBState.db.risuBardArcaChatFontSizePx` to `buildArcaClipboardHtml`, and the Korean action label is `아카라이브 챗 저장기`.

- [ ] **Step 2: Run and verify RED**

Run the integration test and expect missing option references.

- [ ] **Step 3: Wire global settings at click time**

Read both values directly from `DBState.db` inside the existing message action so every character and chat uses the same current settings. Update action/success/failure copy to the new feature name.

- [ ] **Step 4: Re-run and verify GREEN**

Run the integration and settings tests together and expect all cases to pass.

### Task 5: Final verification

- [ ] Run the focused saver, exporter, settings, and integration tests.
- [ ] Run `node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json` and require 0 errors and 0 warnings.
- [ ] Run `git diff --check`, review only scoped changes, and confirm unrelated dirty MemoryWiki/StorySoFar files remain untouched.
