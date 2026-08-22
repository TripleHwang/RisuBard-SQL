# Collection Folders and Cache Tools

**Goal:** Organize prompt presets, modules, and plugins without changing their source objects; add active-persona module assignments and an LLM translation-cache manager.

## Completed

- [x] Stable-ID, single-level virtual folders for prompt presets, modules, and plugins.
- [x] Shared manager with All/Uncategorized, search, counts, selection, bulk move, drag assignment, and reorder controls.
- [x] Persona-scoped module assignments added to existing activation scopes.
- [x] Persistent LLM translation-cache paging, exact-key edit/delete, import/export, and clear operations.
- [x] Focused tests, type checks, theme-token checks, and documentation review completed.

## Final contract

- Folder metadata is external to preset, module, and plugin payloads and uses stable item IDs.
- Folder actions preserve runtime identities and the active prompt preset selection.
- Persona assignments only apply for the currently active persona and add to existing module scopes.
- Translation-cache mutations persist only after durable storage succeeds; same-key mutations are serialized and clear prevents stale writes from being republished.
