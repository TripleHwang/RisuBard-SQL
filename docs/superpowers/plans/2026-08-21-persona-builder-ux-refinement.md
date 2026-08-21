# Persona Builder UX Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the persona builder prompts, generation controls, draft recovery, dialog height, and persona surface hierarchy.

**Architecture:** Keep request compilation and preset storage unchanged except for the two built-in style prompt openers. Add one-level draft recovery as local builder UI state. Add theme-derived semantic surface tokens and consume them only in the persona manager and builder.

**Tech Stack:** Svelte 5, TypeScript, Tailwind CSS v4 theme variables, Vitest.

---

### Task 1: Built-in style preset output contract

**Files:**
- Modify: `src/ts/personaBuilder.ts`
- Test: `src/ts/personaBuilder.test.ts`

- [ ] Add assertions that the Korean preset requests Korean-only output and suppresses chain-of-thought, while the English preset requests English-only output and suppresses chain-of-thought.
- [ ] Run `pnpm vitest run src/ts/personaBuilder.test.ts` and confirm the new assertions fail.
- [ ] Replace only the opening paragraph of each built-in style preset.
- [ ] Re-run the targeted test and confirm it passes.

### Task 2: Instruction controls and draft recovery

**Files:**
- Modify: `src/lib/Others/PersonaBuilder.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Test: `src/lib/Others/PersonaBuilder.test.ts`

- [ ] Add source-contract assertions for the new label, icon-only send/reset action column, disabled destructive generating state, persistent instruction, and one-level undo.
- [ ] Run the UI test and confirm the assertions fail.
- [ ] Keep `userInstruction` after a successful request; capture `draft` before replacing it; expose an undo button in the draft header.
- [ ] Place the instruction textarea and vertical action buttons in one row, with reset below send.
- [ ] Re-run the UI test and confirm it passes.

### Task 3: Surface hierarchy and dialog height

**Files:**
- Modify: `src/styles.css`
- Modify: `src/lib/Others/PersonaBuilder.svelte`
- Modify: `src/lib/Setting/Pages/PersonaSettings.svelte`
- Test: `src/lib/Others/PersonaBuilder.test.ts`

- [ ] Add failing assertions for `surface-base`, `surface-raised`, and `surface-inset` theme tokens and 90vh builder height.
- [ ] Declare all three tokens in `@theme`, derived from existing runtime theme variables.
- [ ] Apply base to the builder dialog, raised to builder/persona panels, and inset to text editing surfaces.
- [ ] Re-run the UI and theme-contract tests.

### Task 4: Verification

**Files:**
- Verify all files changed above.

- [ ] Run `pnpm vitest run src/ts/personaBuilder.test.ts src/lib/Others/PersonaBuilder.test.ts src/lib/Setting/PersonaScopeConnections.test.ts src/lib/UI/GUI/ShSelect.test.ts`.
- [ ] Run `pnpm check:theme-tokens`.
- [ ] Run `pnpm check`.
- [ ] Run `git diff --check` on the touched files and inspect the focused diff.
