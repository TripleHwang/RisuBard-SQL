# First Message Studio Option Presentations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authors show a localized speaker, description, and optional character-card illustration that changes when a First Message Studio option is hovered or keyboard-focused.

**Architecture:** Each screen owns an opt-in `optionPresentationEnabled` flag and each option owns an optional localized presentation record. Illustration references store an `additionalAssets` name rather than a local path so card export/import can remap the underlying content-addressed asset safely. The native runtime resolves that name to a character asset path, while the compatibility compiler emits `{{raw::assetName}}` and CSS `:has()` hover rules.

**Tech Stack:** TypeScript, Svelte 5, Vitest, existing `saveAsset`/`getFileSrc`, character `additionalAssets`, CBS compatibility HTML.

---

### Task 1: Presentation data contract and localization

**Files:**
- Modify: `src/ts/firstMessageStudio.ts`
- Modify: `src/ts/firstMessageStudio.test.ts`
- Modify: `src/ts/firstMessageStudioTranslation.ts`
- Modify: `src/ts/firstMessageStudioTranslation.test.ts`

- [ ] **Step 1: Write failing normalization and translation tests**

Assert that a stage flag and option presentation survive normalization, malformed asset names become empty, and speaker/description participate in project-wide translation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts src/ts/firstMessageStudioTranslation.test.ts`

- [ ] **Step 3: Add the presentation interfaces and normalizer**

Add:

```ts
export interface FirstMessageStudioOptionPresentation {
    speaker?: FirstMessageStudioText
    description: FirstMessageStudioText
    imageEnabled: boolean
    imageAssetName?: string
}
```

Add `optionPresentationEnabled` to stages and optional `presentation` to options. Normalize text fields and trim asset names without interpreting them as filesystem paths.

- [ ] **Step 4: Extend stable translation traversal and verify GREEN**

Visit `stage.<id>.option.<id>.presentation.speaker` and `.description`, then rerun the focused tests.

### Task 2: Native hover and keyboard-focus runtime

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts`
- Modify: `src/lib/ChatScreens/Chat.svelte`

- [ ] **Step 1: Write a failing runtime interaction test**

Mount a two-option stage with different speakers/descriptions and asset names. Assert the first option is the default, `pointerenter` and `focus` switch the panel, disabled images do not render, and `getFileSrc` receives the resolved `additionalAssets` path.

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npx vitest run src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts`

- [ ] **Step 3: Implement active-option state and asset resolution**

Add an `assets` prop, resolve the active option from hover/focus with first-option fallback, load image URLs through `getFileSrc`, and render the dynamic panel below the stage heading. Preserve the existing static stage description when the feature is disabled.

- [ ] **Step 4: Pass character assets from chat and verify GREEN**

Pass `current.additionalAssets ?? []` in `Chat.svelte`, then rerun the runtime test.

### Task 3: No-code presentation editor and asset upload

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`

- [ ] **Step 1: Write failing editor tests**

Assert a screen-level toggle, option tabs, localized speaker/description inputs, per-option illustration toggle, upload/remove controls, immediate preview asset resolution, and persistence of the created `additionalAssets` entry and presentation reference.

- [ ] **Step 2: Run the editor test and verify RED**

Run: `npx vitest run src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`

- [ ] **Step 3: Implement the inline tabbed editor**

Place the block after screen tag/title fields. Initialize missing presentation records lazily, track the selected tab by option ID, and keep the block absent when disabled.

- [ ] **Step 4: Implement image selection and storage**

Use `selectFileByDom(['png','webp','jpeg','jpg','gif','avif'])`, save bytes with `saveAsset`, append a collision-safe `[assetName, assetPath, extension]` tuple to `character.additionalAssets`, and store only `assetName` in the option presentation. Clearing a reference must not destructively delete the shared asset.

- [ ] **Step 5: Pass assets into the editor preview and verify GREEN**

Render `<FirstMessageStudioRuntime assets={character.additionalAssets ?? []}>` and rerun the editor tests.

### Task 4: Risu-compatible hover presentation

**Files:**
- Modify: `src/ts/firstMessageStudioSharing.ts`
- Modify: `src/ts/firstMessageStudioSharing.test.ts`

- [ ] **Step 1: Write a failing compatibility test**

Assert generated HTML contains localized presentation copy, `{{raw::assetName}}`, a first-option default panel, and option-specific hover/focus CSS.

- [ ] **Step 2: Run the sharing test and verify RED**

Run: `npx vitest run src/ts/firstMessageStudioSharing.test.ts`

- [ ] **Step 3: Compile presentation panels and hover rules**

Generate deterministic stage/option classes by indexes, escape all author text and asset names, and keep the existing static description path when the feature is disabled.

- [ ] **Step 4: Run the sharing test and verify GREEN**

Run the focused sharing test again.

### Task 5: Regression and production verification

**Files:**
- Verify all modified files

- [ ] **Step 1: Run affected tests**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts src/ts/firstMessageStudioTranslation.test.ts src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/lib/ChatScreens/FirstMessageStudioIntegration.test.ts src/ts/firstMessageStudioSharing.test.ts src/ts/characterCards.test.ts`

- [ ] **Step 2: Run static checks**

Run: `npm run check`

- [ ] **Step 3: Run production build and diff validation**

Run: `npm run build` and `git diff --check`.

### Task 6: Illustration framing and stacked copy

**Files:**
- Modify: `src/ts/firstMessageStudio.ts`
- Modify: `src/ts/firstMessageStudio.test.ts`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts`
- Modify: `src/ts/firstMessageStudioSharing.ts`
- Modify: `src/ts/firstMessageStudioSharing.test.ts`

- [x] **Step 1: Write failing framing tests**

Assert that presentation normalization preserves `contain`, `square`, `landscape`, and `portrait`, rejects unknown modes to `contain`, the editor exposes all four choices, and native/compatibility output carries a deterministic frame-mode class.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/ts/firstMessageStudioSharing.test.ts`

- [x] **Step 3: Add the frame-mode data contract and editor control**

Add `imageFrame: 'contain' | 'square' | 'landscape' | 'portrait'` to `FirstMessageStudioOptionPresentation`, default it to `contain`, and render a four-option selector next to the illustration controls with concise Korean labels and tooltips.

- [x] **Step 4: Stack illustration and copy in the native runtime**

Render the image in its own centered frame and place speaker/description in a separate row below it. Use `object-fit: contain` for `contain`, centered `object-fit: cover` with `aspect-ratio: 1` for `square`, `16 / 9` for `landscape`, and `3 / 4` for `portrait`.

- [x] **Step 5: Match the Risu-compatible output**

Emit the same frame-mode class and stacked layout in the compatibility compiler, retaining hover and keyboard-focus switching.

- [x] **Step 6: Verify GREEN and production checks**

Run the focused tests, affected suite, `npm run check`, `npm run build`, and `git diff --check`.

### Task 7: Direct focal-point crop editor

**Files:**
- Create: `src/lib/FirstMessageStudio/FirstMessageStudioImageCropEditor.svelte`
- Modify: `src/ts/firstMessageStudio.ts`
- Modify: `src/ts/firstMessageStudio.test.ts`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts`
- Modify: `src/ts/firstMessageStudioSharing.ts`
- Modify: `src/ts/firstMessageStudioSharing.test.ts`

- [x] **Step 1: Write failing focal-point tests**

Assert that X/Y crop positions default to 50, normalize to the 0–100 range, are changed by pointer dragging in the editor, and are emitted as explicit `object-position` values in native and compatibility output.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/ts/firstMessageStudioSharing.test.ts`.

- [x] **Step 3: Add persistent focal-point coordinates**

Add `imagePositionX` and `imagePositionY` to option presentations. Normalize finite input to 0–100 and default missing or invalid input to 50 so existing projects remain geometrically centered.

- [x] **Step 4: Build the direct manipulation crop editor**

Resolve the selected character asset, show the chosen square/landscape/portrait viewport with a solid crop guide, and update the X/Y coordinates while the author drags the image. Include a one-click center reset. Hide the drag tool for the no-crop mode.

- [x] **Step 5: Apply the saved focal point everywhere**

Use an explicit inline `object-position: X% Y%` in the native runtime and compatibility HTML so global image styles cannot override the chosen crop.

- [x] **Step 6: Verify GREEN and production checks**

Run focused tests, the affected suite, `npm run check`, `npm run build`, and `git diff --check`.
