# Inline Collection Lists and Plugin Update Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the metadata-only collection dialog with folder-aware default lists that retain every existing preset, module, and plugin action, while fixing folder deletion and plugin update feedback/durability.

**Architecture:** A reusable inline `CollectionOrganizerList` owns folder CRUD, filtering, ordering, drag assignment, selection, and bulk moves. Parent settings pages provide the real item-row snippet, so organization and operational actions have one source of truth. Plugin update orchestration becomes awaitable and verifiable, bypasses stale browser cache, and reports success or failure.

**Tech Stack:** Svelte 5 runes/snippets, TypeScript, Vitest, existing collection organizer metadata, existing settings/theme components.

---

### Task 1: Reproduce and fix plugin updating

**Files:**
- Modify: `src/ts/plugins/plugins.svelte.ts`
- Create: `src/ts/plugins/pluginUpdate.test.ts`
- Modify: `src/lib/Setting/Pages/PluginSettings.svelte`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`

- [ ] **Step 1: Write failing updater tests**

Test `updatePlugin()` with injected fetch/import/read dependencies. Assert that it requests with `cache: 'no-store'`, waits for the importer, returns false when the installed script did not change, returns true only after the downloaded source becomes the installed source, and clears the update-check cache only on success.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/ts/plugins/pluginUpdate.test.ts`

Expected: FAIL because the updater has no verifiable dependency boundary, uses a cacheable fetch, and reports success without checking installation.

- [ ] **Step 3: Implement the minimal updater contract**

Add an optional dependency object to `updatePlugin`:

```ts
interface PluginUpdateDependencies {
    fetcher: typeof fetch
    importer: typeof importPlugin
    readInstalled: (name: string) => RisuPlugin | undefined
}
```

Fetch with `{ cache: 'no-store' }`, reject non-2xx responses, await import, verify the installed script equals the downloaded source, clear the per-plugin update cache on success, and return a boolean. In the plugin row, await the result, disable repeated clicks while updating, and show localized success/failure feedback.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/ts/plugins/pluginUpdate.test.ts`

Expected: PASS.

### Task 2: Build the inline collection list

**Files:**
- Create: `src/lib/UI/CollectionOrganizerList.svelte`
- Create: `src/lib/UI/CollectionOrganizerList.test.ts`
- Modify: `src/ts/collectionOrganizer.ts`
- Modify: `src/ts/collectionOrganizer.test.ts`
- Delete: `src/lib/UI/CollectionOrganizerDialog.svelte`

- [ ] **Step 1: Write failing layout/behavior tests**

Assert that the new component is inline and contains no `ShDialog`; parent-provided item content is rendered inside the organized list; deleting a folder calls `deleteCollectionFolder`, returns its items to uncategorized, and selects All; item order remains stable under folder/search filtering.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/lib/UI/CollectionOrganizerList.test.ts src/ts/collectionOrganizer.test.ts`

Expected: FAIL because the inline component does not exist.

- [ ] **Step 3: Implement the shared inline layout**

Use a responsive `md:grid-cols-[13rem_minmax(0,1fr)]` layout. The left rail contains All, Uncategorized, folder counts, folder reorder, rename/delete, and creation. The right pane contains search, select-visible/clear, bulk move, and the actual item rows supplied through a snippet. Preserve drag-to-folder and visible-item reorder with keyboard buttons. Call `requestImmediateSave()` after organizer mutations.

- [ ] **Step 4: Verify GREEN and theme contract**

Run:

```powershell
npx vitest run src/lib/UI/CollectionOrganizerList.test.ts src/ts/collectionOrganizer.test.ts
npm run check:theme-tokens
```

Expected: PASS.

### Task 3: Integrate prompt presets into the default list

**Files:**
- Modify: `src/lib/Setting/botpreset.svelte`

- [ ] **Step 1: Add a failing source contract test**

Extend `CollectionOrganizerList.test.ts` to require `botpreset.svelte` to use the inline list and to reject `CollectionOrganizerDialog` or a `폴더로 정리` launcher.

- [ ] **Step 2: Replace the separate list/dialog pair**

Render each actual preset row through the inline list snippet. Preserve active selection, stable active preset during reorder/delete, edit mode, comparison, create, import, duplicate, export, and delete. Newly created/imported presets are assigned to the currently selected real folder when applicable.

- [ ] **Step 3: Verify**

Run: `npx vitest run src/lib/UI/CollectionOrganizerList.test.ts src/ts/collectionOrganizer.test.ts`

Expected: PASS.

### Task 4: Integrate modules into the default list

**Files:**
- Modify: `src/lib/Setting/Pages/Module/ModuleSettings.svelte`
- Modify: `src/lib/Setting/Pages/Module/ModuleSettings.test.ts`

- [ ] **Step 1: Write failing integration assertions**

Require the inline list and the real global-toggle, persona-assignment, export, edit, and delete controls in its item snippet. Reject the old dialog launcher.

- [ ] **Step 2: Implement module rows inside the organizer**

Use stable module IDs. Preserve global activation, persona count/manager, MCP restrictions, export, edit, conversion, delete cleanup, create/import controls, descriptions, and search. Folder filtering must not affect runtime module resolution.

- [ ] **Step 3: Verify**

Run: `npx vitest run src/lib/Setting/Pages/Module/ModuleSettings.test.ts src/ts/process/modules.test.ts src/ts/storage/personaEnabledModules.test.ts`

Expected: PASS.

### Task 5: Integrate plugins into the default list

**Files:**
- Modify: `src/lib/Setting/Pages/PluginSettings.svelte`
- Modify: `src/lib/UI/CollectionOrganizerList.test.ts`

- [ ] **Step 1: Write failing integration assertions**

Require the inline list and the actual update, custom-link, enable, permission-reset, delete, argument expansion, import, and developer controls in its item snippet. Reject the old dialog launcher.

- [ ] **Step 2: Implement plugin rows inside the organizer**

Use `plugin.name` as identity and replace index-based expanded state with plugin-name state. Preserve every existing row action and argument editor. Update/delete operations must locate the live plugin by name so filtering and visual reordering cannot target the wrong item.

- [ ] **Step 3: Verify**

Run: `npx vitest run src/lib/UI/CollectionOrganizerList.test.ts src/ts/plugins/pluginUpdate.test.ts`

Expected: PASS.

### Task 6: Documentation and final verification

**Files:**
- Modify: `project_wiki/prompt_and_tool_preset_architecture.md`
- Modify: `patchnote/0.8.7.md`

- [ ] **Step 1: Update reviewed behavior**

Document that collection folders are part of each default list rather than a separate manager, and that the row retains its native operations. Add folder deletion and plugin update fixes to the 0.8.7 notes.

- [ ] **Step 2: Run final verification**

Run:

```powershell
npx vitest run src/lib/UI/CollectionOrganizerList.test.ts src/ts/collectionOrganizer.test.ts src/lib/Setting/Pages/Module/ModuleSettings.test.ts src/ts/process/modules.test.ts src/ts/storage/personaEnabledModules.test.ts src/ts/plugins/pluginUpdate.test.ts
npm run check
npm run check:theme-tokens
git diff --check
```

Expected: all exit 0 with no new errors or warnings.
