# Upstream Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely adapt the approved upstream fixes and features through the Gemini 3.7 bundled profiles without extending the SQLite runtime, while completing Lua caching and lightweight chat APIs last.

**Architecture:** Port behavior, not files: preserve RisuBard's preset adapters, file-native storage direction, scoped personas, novelist project toggles, and custom theme tokens. Every behavior change gets a focused regression test before production code. Independent compatibility domains are delegated, then reviewed and verified together; Lua/runtime work remains the final integration stage.

**Tech Stack:** TypeScript, Svelte 5, Vitest, DOMPurify, Wasmoon Lua, RisuBard preset adapters.

---

## File map

- `src/ts/bootstrap.ts`, `src/ts/globalApi.svelte.ts`, `src/ts/storage/database.svelte.ts`: opt-in asset cleanup and complete reference discovery without new SQLite cleanup code.
- `src/ts/storage/risuSave.ts`, `src/ts/storage/risuSavePatcher.test.ts`: large lorebook patch append without spread overflow.
- `src/ts/parser/parser.svelte.ts`, `src/ts/parser/tests/trimMarkdownStyle.test.ts`: DOM-based `<risu-style>` restoration with sanitization guarantees.
- `src/ts/interchangeability.ts`, `src/ts/characterCards.ts` and focused tests: module namespace, replacement note, and card extension preservation.
- `src/ts/process/request/**`: Responses reasoning controls, actual wire-model provenance, and recovery metadata.
- `src/ts/plugins/apiV3/**`: wake-lock permission, inlay permission, chat-output listener lifecycle, declarations, and consent text.
- `src/ts/process/novelAIImage.ts`, test: NAI V5 curated capability handling.
- `src/ts/preset/bundled/profiles/**`, `src/ts/preset/bundled/loader.test.ts`: Gemini 3.7 Flash bundled provider profiles.
- `src/lib/SideBars/Scripts/RegexData.svelte`, `src/ts/util.ts`, `src/ts/personaScopes.ts`, `src/lib/SideBars/ModelBind.svelte`: small upstream safety and navigation fixes.
- `src/ts/parser/chatVar.svelte.ts`, `src/ts/storage/database.svelte.ts`, toggle settings UI and tests: explicit per-chat global-toggle pinning in chat mode only.
- `src/lib/Setting/Pages/Display/ColorSchemeSelect.svelte`, `src/ts/gui/colorschemePalettes.ts` and UI tests: visual palette cards adapted to RisuBard tokens.
- `src/ts/process/scriptings.ts`, `src/ts/process/triggers.ts`, chat variable/runtime helpers and tests: Lua engine cache and lightweight recent-chat APIs, implemented last.

### Task 1: Asset cleanup safety and large-save robustness

- [ ] Add failing tests proving automatic orphan deletion is disabled by default and all known nested asset references survive an explicitly enabled cleanup scan.
- [ ] Run the focused tests and confirm they fail because the opt-in flag/reference extraction is absent.
- [ ] Add `nodeOnlyAutoCleanAssets?: boolean` migration/default false; gate only asset deletion, keep remote cleanup behavior, and collect NAI, Wavespeed, GPT-SoVits, persona, legacy plugin storage, and V3 plugin storage references.
- [ ] Add a failing 30,000-entry lorebook patch regression proving `patch.push(...charPatch)` overflows.
- [ ] Replace the spread with bounded iteration and verify patch generation plus round-trip reconstruction.
- [ ] Run `pnpm vitest run src/ts/storage/risuSavePatcher.test.ts` and the new asset-reference tests.

### Task 2: Sanitized CSS and card/module round-trip compatibility

- [ ] Add failing parser tests for SVG data URIs, markup-like CSS `content`, and hostile closing-style injection.
- [ ] Restore encoded style nodes through a sanitized DOM, replace only `risu-style` nodes with real `style` nodes, and retain RisuBard's cache and custom allowed attributes.
- [ ] Add failing round-trip tests for `moduleNamespace`, `hideChatIcon`, cloned lorebooks, `replace_global_note`, and legacy `phi` import.
- [ ] Adapt character-card and module conversion while preserving backward compatibility.
- [ ] Run the focused parser, interchangeability, and card tests.

### Task 3: Request provenance, plugin APIs, NAI V5, and Gemini profiles

- [ ] Add failing request tests proving Responses API bodies preserve supported reasoning effort/verbosity controls and that logs/jobs/recovered messages record the resolved wire model ID.
- [ ] Apply controls through the existing adapter capability path and centralize provenance fallback around `resolveWireModelId`.
- [ ] Add failing plugin tests for `screen-wake-lock`, consent-gated `readInlay`, output listener snapshots, removal, unload cleanup, and listener error isolation.
- [ ] Implement the V3 APIs/declarations and localized permission description without altering unrelated plugin permissions.
- [ ] Add failing NAI V5 curated tests, then treat full and curated as the same V5 capability family.
- [ ] Add six Gemini 3.7 Flash bundled profiles (Google, Vertex native, OpenRouter, NanoGPT, LLM Gateway, Vercel) and update registry expectations.
- [ ] Run focused request, plugin, NAI, and bundled-profile tests.

### Task 4: Small UI/data guards

- [ ] Add focused failing tests where practical for missing regex flags, canceled/unsupported file selection, out-of-range persona selection, and the model-mode settings target.
- [ ] Normalize missing regex flags, return `null` plus the existing unsupported-file notification, and guard nullable call sites.
- [ ] Clamp invalid selected persona through the scoped persona resolver/migration rather than duplicating selection logic.
- [ ] Point the model-mode gear to model preset options.
- [ ] Run affected unit/component tests.

### Task 5: Per-chat toggle pinning

- [ ] Add failing tests proving chat mode can copy current global toggle values into a per-chat override map, including empty-string values, while novelist projects remain unchanged.
- [ ] Add optional typed chat fields and legacy normalization; resolve local values with own-property checks and global fallback.
- [ ] Add a clear `채팅에 고정` control that pins/unpins the current chat and never conflates toggle presets with local overrides.
- [ ] Verify chat switching, pin removal, default fallback, empty values, and novelist-mode isolation.

### Task 6: Visual theme palette selector

- [ ] Add a failing component/contract test for visual palette cards, selected state, custom theme access, and required `primary`/`accentText` preview tokens.
- [ ] Replace the plain dropdown with accessible cards using RisuBard's existing palette registry and tokens; do not import upstream colors that violate the theme contract.
- [ ] Run the component test and `pnpm run check:theme-tokens`.

### Task 7: Lua engine cache and lightweight chat APIs (last)

- [ ] Add failing tests for cache reuse by script identity, invalidation on source/permission changes, unload/reset disposal, no-op state writes, and lightweight recent-chat summaries.
- [ ] Introduce a bounded Lua-engine cache with explicit lifecycle ownership; never reuse a VM across incompatible script identities.
- [ ] Avoid state-change propagation for deep-equal writes and expose recent chats without loading full message bodies.
- [ ] Run scripting, trigger, chat-variable, generation-stop, and recent-chat tests together.

### Task 8: Integration review and verification

- [ ] Review every diff against Tasks 1–7, explicitly confirming SQLite stabilization and PWA/share-target removal were not introduced.
- [ ] Run all newly affected test files, then `pnpm run check`, `pnpm run check:public-boundary`, `pnpm run check:brand-boundary`, `pnpm run check:theme-tokens`, and `pnpm run build`.
- [ ] Run `git diff --check` and inspect `git status --short`; leave changes uncommitted until the user asks for a commit.
