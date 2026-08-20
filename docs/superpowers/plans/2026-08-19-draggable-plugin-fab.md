# Draggable Plugin FAB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make official plugin floating action buttons draggable and persist their user-chosen positions without requiring plugin authors to adopt a new API.

**Architecture:** Keep `registerButton()` source-compatible and enrich host-owned menu entries with plugin ownership and a stable layout key. Render action buttons through a focused Svelte layer that separates click from pointer drag, stores normalized viewport coordinates only when dragging ends, and falls back to the current non-overlapping top-right stack. Persist placements in the existing reactive database and scope menu identity by plugin so identical IDs from different plugins cannot replace or unregister each other.

**Tech Stack:** Svelte 5, TypeScript, Vitest, happy-dom, existing reactive `DBState` persistence.

---

### Task 1: Layout and identity contract

**Files:**
- Create: `src/ts/plugins/floatingActionButtonLayout.test.ts`
- Create: `src/ts/plugins/floatingActionButtonLayout.ts`
- Modify: `src/ts/stores.svelte.ts`

- [ ] Write failing tests proving plugin-scoped identity, stable-ID and name fallback layout keys, default vertical placement, corrupt coordinate normalization, and viewport clamping.
- [ ] Run `pnpm vitest run src/ts/plugins/floatingActionButtonLayout.test.ts` and confirm failure because the helper module does not exist.
- [ ] Implement the smallest pure layout/identity helpers and extend `MenuDef` with `pluginName` and `layoutKey`.
- [ ] Re-run the targeted test and confirm it passes.

### Task 2: Accessible draggable FAB layer

**Files:**
- Create: `src/lib/Others/PluginFloatingActionButtons.test.ts`
- Create: `src/lib/Others/PluginFloatingActionButtons.svelte`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`

- [ ] Write failing component tests proving a normal click invokes the plugin callback, a pointer drag persists a normalized position without invoking the callback, restored positions render, and keyboard reset returns a button to its default stack position.
- [ ] Run `pnpm vitest run src/lib/Others/PluginFloatingActionButtons.test.ts` and confirm failure because the component does not exist.
- [ ] Implement the component with pointer capture, a movement threshold, viewport clamping, `aria-label`, `title`, keyboard movement/reset, and host callbacks for persistence.
- [ ] Replace the inline FAB block in `DefaultChatScreen.svelte` with the component and database placement adapter.
- [ ] Re-run the component and layout tests and confirm they pass.

### Task 3: Plugin lifecycle stability and persistence schema

**Files:**
- Modify: `src/ts/plugins/apiV3/v3.svelte.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/plugins/floatingActionButtonLayout.test.ts`

- [ ] Add a failing ownership test showing identical public button IDs from different plugins are distinct.
- [ ] Run the layout test and confirm the new assertion fails against the current ownership helper behavior.
- [ ] Populate `pluginName` and `layoutKey` for registered UI items, scope replacement/unload/unregister operations to the calling plugin, and add the optional placement map to `Database`.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 4: Plugin author documentation and verification

**Files:**
- Modify: `src/ts/plugins/apiV3/risuai.d.ts`
- Modify: `plugins.md`
- Modify: `src/ts/plugins/migrationGuide.md`

- [ ] Document that official action buttons are draggable automatically, stable `id` values preserve user positions across restarts, ID namespaces are plugin-scoped, and missing IDs use a best-effort name fallback.
- [ ] Run `pnpm vitest run src/ts/plugins/floatingActionButtonLayout.test.ts src/lib/Others/PluginFloatingActionButtons.test.ts`.
- [ ] Run `pnpm check` and `git diff --check` to validate types, Svelte diagnostics, and patch formatting.

