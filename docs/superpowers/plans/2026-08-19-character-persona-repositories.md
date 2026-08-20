# Character Persona Repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add character-owned persona repositories, per-chat references to either character or global personas, scoped management tabs and visible scope badges.

**Architecture:** Keep `Database.personas` and `selectedPersona` as the backward-compatible global store. Add `character.personas?: RisuPersona[]`; continue persisting the existing `Chat.bindedPersona` stable ID and resolve it against the current character store before the global store. Centralize lookup and cloning rules in a pure module so prompt generation, chat rendering and both sidebars share one contract.

**Tech Stack:** TypeScript, Svelte 5, Vitest, existing RisuBard GUI components and Solar Bold SVG paths.

---

### Task 1: Scoped persona domain rules

**Files:**
- Create: `src/ts/personaScopes.test.ts`
- Create: `src/ts/personaScopes.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/util.ts`

- [ ] **Step 1: Write failing tests** for character-first ID resolution, global fallback, effective-global fallback, empty character repositories and numbered clone names.
- [ ] **Step 2: Run `pnpm vitest run src/ts/personaScopes.test.ts`** and confirm failure because `personaScopes.ts` does not exist.
- [ ] **Step 3: Implement** `PersonaScope`, `PersonaSelection`, `getCharacterPersonas`, `resolvePersonaById`, `getEffectivePersona`, `nextPersonaCopyName` and `clonePersonaToStore`; add `personas?: RisuPersona[]` to `character` and route `checkPersonaBinded()` through the resolver.
- [ ] **Step 4: Re-run the targeted test** and confirm all scoped-domain tests pass.

### Task 2: Scoped manager and chat profile selector

**Files:**
- Create: `src/lib/Setting/PersonaScopeConnections.test.ts`
- Modify: `src/lib/Setting/Pages/PersonaSettings.svelte`
- Modify: `src/ts/persona.ts`
- Modify: `src/lib/SideBars/PersonaBind.svelte`
- Modify: `src/lib/Setting/listedPersona.svelte`
- Modify: `src/ts/stores.svelte.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`

- [ ] **Step 1: Write failing source-contract tests** requiring Global/Character tabs, Duplicate/Clone-to-character actions, the current-character empty state and both persona stores in the chat selector.
- [ ] **Step 2: Run `pnpm vitest run src/lib/Setting/PersonaScopeConnections.test.ts`** and confirm the new UI contract is absent.
- [ ] **Step 3: Refactor persona import/export/image helpers** to accept an explicit persona or target store while preserving the existing no-argument global behavior.
- [ ] **Step 4: Implement the manager tabs** with independent selection, direct character-store editing, current-chat binding on character selection, numbered global duplication, numbered clone-to-character and safe deletion/unbinding.
- [ ] **Step 5: Extend the chat profile selector** to show character personas before global personas and bind stable IDs from either scope.
- [ ] **Step 6: Re-run the source-contract and scoped-domain tests** and confirm they pass.

### Task 3: Effective persona rendering and Solar scope badges

**Files:**
- Modify: `src/lib/UI/Icons/SolarBoldIcon.svelte`
- Modify: `src/lib/SideBars/Sidebar.svelte`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lib/SideBars/CharacterVaultConnections.test.ts`

- [ ] **Step 1: Add failing assertions** that the Solar icon component includes `earth`, the main persona thumbnail renders an Earth/People Nearby scope badge, and chat rendering resolves bound character personas.
- [ ] **Step 2: Run the affected Vitest files** and confirm the new assertions fail for the missing badge/resolver integration.
- [ ] **Step 3: Add the Solar Bold Earth path** from `solar-icons-main` and render a compact upper-right scope badge on the effective persona thumbnail.
- [ ] **Step 4: Replace direct global-array lookups** in chat message rendering and input identity with the shared character-first resolver.
- [ ] **Step 5: Run targeted Vitest tests, `pnpm check`, and `pnpm check:theme-tokens`**; address only failures caused by this feature.

No commits are created because this checkout already contains unrelated user-owned changes and the user did not request a commit.
