# Generic First Message Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a generic, no-code first-message builder whose defaults contain only reusable screens, variables, choices, and window appearance controls, with scoped advanced CSS and sanitized extra HTML for custom presentation.

**Architecture:** Keep the project as a versioned character-card extension. A pure TypeScript engine normalizes registered variables, screens, choice assignments, navigation, completion, and advanced code. The Svelte runtime renders neutral card UI only. Custom CSS is constrained to the runtime root and extra HTML is sanitized before rendering; executable JavaScript is never loaded from character data.

**Tech Stack:** Svelte 5 runes, TypeScript, DOMPurify, existing theme tokens, Vitest.

---

### Task 1: Replace the specialized project model with a generic model

**Files:**
- Modify: `src/ts/firstMessageStudio.ts`
- Modify: `src/ts/firstMessageStudio.test.ts`

- [ ] Add failing tests for a neutral default project with no branded template or broadcast controls.
- [ ] Add failing tests for registered variables, variable choice values, default values, screen navigation, completion, and reset.
- [ ] Add failing tests for normalized custom CSS and extra HTML fields.
- [ ] Implement the generic project model and preserve tolerant normalization for previously stored unknown fields.

### Task 2: Rebuild the runtime as a neutral window

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioRuntime.test.ts`

- [ ] Add failing component tests for title, progress, choices, input, back/reset, custom colors, and custom code.
- [ ] Remove broadcast chrome, status lamps, screen noise, dials, channel language, and themed animation rules.
- [ ] Render sanitized extra HTML and scope custom CSS to one runtime instance.

### Task 3: Rebuild the editor around minimum generic authoring

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`

- [ ] Add failing editor tests for neutral startup, variable registration, variable value choices, screen editing, appearance settings, CSS, and extra HTML.
- [ ] Replace template and skin marketing with Content, Variables, Design, and Advanced Code areas.
- [ ] Keep only title, progress, and navigation as standard visibility switches.
- [ ] Provide code editors with scope/sanitization guidance and a live preview.

### Task 4: Update persistence integration and verify

**Files:**
- Modify: `src/ts/characterCards.test.ts`
- Modify: `src/lib/ChatScreens/FirstMessageStudioIntegration.test.ts`

- [ ] Update fixtures to use the neutral factory and assert registered variables/custom code survive card round trips.
- [ ] Run all First Message Studio and character-card tests.
- [ ] Run `pnpm check`, the theme-token contract, and `git diff --check`.
