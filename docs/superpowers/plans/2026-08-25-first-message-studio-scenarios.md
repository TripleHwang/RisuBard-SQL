# First Message Studio Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authors build multiple conditional, localized completion scenarios without writing CBS formulas.

**Architecture:** Add ordered scenario rules to the Studio project. Each rule contains AND-connected groups; each group contains OR-connected variable comparisons and a localized message. The compatibility compiler renders matching rules after setup completion and renders the existing completion message only when no rule matches. The editor gets a dedicated `시나리오` primary tab using existing variables and effect-created variables.

**Tech Stack:** TypeScript, Svelte 5, Vitest, existing CBS/trigger/card serialization.

---

### Task 1: Scenario data contract and evaluator

**Files:**
- Modify: `src/ts/firstMessageStudio.ts`
- Modify: `src/ts/firstMessageStudio.test.ts`

- [ ] **Step 1: Write failing normalization and matching tests**

Test that a rule with two groups matches only when every group has at least one matching condition, supports `equals` and `not-equals`, and preserves localized messages through normalization.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts`

- [ ] **Step 3: Implement the scenario interfaces, normalizer, and evaluator**

Add `scenarioRules` to `FirstMessageStudioProject`, normalize malformed IDs/operators/groups, and export `matchesFirstMessageStudioScenario`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts`

### Task 2: Compatibility compilation

**Files:**
- Modify: `src/ts/firstMessageStudioSharing.ts`
- Modify: `src/ts/firstMessageStudioSharing.test.ts`

- [ ] **Step 1: Write failing scenario CBS compilation tests**

Assert nested AND/OR comparisons, localized scenario messages, and fallback output guarded by the inverse of every rule.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/ts/firstMessageStudioSharing.test.ts`

- [ ] **Step 3: Compile scenario conditions and completion output**

Generate CBS expressions from normalized groups. Emit each scenario message under its condition and emit `fallbackMessage` only when no scenario condition matches.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/ts/firstMessageStudioSharing.test.ts`

### Task 3: No-code scenario editor

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`
- Modify: `src/ts/firstMessageStudioTranslation.ts`
- Modify: `src/ts/firstMessageStudioTranslation.test.ts`

- [ ] **Step 1: Write failing editor and translation tests**

Assert the `시나리오` tab, adding/removing/reordering rules, OR rows inside AND groups, variable/operator/value editing, localized message editing, and automatic translation collection/application.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/ts/firstMessageStudioTranslation.test.ts`

- [ ] **Step 3: Implement the scenario editor**

Add a sixth sticky primary tab, a compact rule stack, condition-group controls, available-variable suggestions, localized message textarea, and empty-state guidance. Keep screen selection returning to the screen editor.

- [ ] **Step 4: Extend automatic translation**

Include each scenario message in the existing project-wide UI translation payload and apply translated results back by stable rule ID.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/ts/firstMessageStudioTranslation.test.ts`

### Task 4: Migration and verification

**Files:**
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts`

- [ ] **Step 1: Add a failing legacy-source preservation test**

When an older project has an empty `fallbackMessage` and the character still contains a non-generated first message, opening the editor must seed the completion source from that message before the first compatibility save.

- [ ] **Step 2: Implement the narrow migration and verify focused tests**

Use the compiler marker to distinguish generated output from legacy source and never replace a non-empty project completion source.

- [ ] **Step 3: Run all affected tests**

Run: `npx vitest run src/ts/firstMessageStudio.test.ts src/ts/firstMessageStudioSharing.test.ts src/ts/firstMessageStudioTranslation.test.ts src/lib/ChatScreens/FirstMessageStudioIntegration.test.ts src/lib/FirstMessageStudio/FirstMessageStudioEditor.test.ts src/ts/characterCards.test.ts`

- [ ] **Step 4: Run static and production verification**

Run: `npm run check`, `npm run build`, and `git diff --check`.
