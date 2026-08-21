# Persona Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an iterative, context-selectable AI persona drafting modal beneath the persona description editor and let the user safely copy its draft into the selected persona.

**Architecture:** Keep builder state local to a new `PersonaBuilder.svelte` modal and isolate prompt/context compilation and prompt-preset operations in a pure `personaBuilder.ts` module. A reusable preset editor serves separate task and style instruction prompts; built-ins live in code while user presets are stored by stable ID in the database. The modal uses the existing main-model request path without chat history or tools; selected project data is serialized as clearly named reference blocks, and an existing result is re-injected as the `초안` / `draft` block on the next request.

**Tech Stack:** Svelte 5, TypeScript, existing `ShDialog`/`ShAccordion`/`ShButton` components, `requestChatData`, Vitest.

---

## Locked product behavior

- The `페르소나 빌더` button is placed immediately below the description resize handle and above the persona action toolbar.
- The builder opens as an `xl` in-app `ShDialog` above the existing persona manager, not as a browser/OS window.
- Builder state is temporary. Closing and reopening starts a fresh session; `리셋` restores the default task instruction, clears the style instruction, enables every available context checkbox, and clears both user instruction and draft.
- `작업 지시 프롬프트` and `스타일 지시 프롬프트` are separate collapsed `ShAccordion` editors. Each has a preset dropdown plus save-new, overwrite, and delete actions. Built-ins are selectable but protected from overwrite/delete; saving edited built-in content creates a user preset.
- User presets have stable IDs, a `task | style` kind, name, and content. They persist in `DBState.db.personaBuilderPromptPresets` and are included in normal database backup/restore.
- The default task instruction is:

  ```text
  이것은 롤플레잉이나 스토리 생성 요청이 아니라 페르소나 설정을 작성·수정하기 위한 out-of-character 작업이다. 절대로 롤플레잉, 장면, 대사 또는 서사를 이어 쓰지 마라. 사용자의 입력을 모두 OOC 편집 지시로 해석하고, 제공된 자료는 사실과 문체를 참고하기 위한 컨텍스트로만 사용하라. 사용자의 최신 지시를 최우선으로 따라 즉시 사용할 수 있는 페르소나 설명 본문만 출력하라. 설명, 서문, 후기, 코드 펜스는 출력하지 마라.
  ```

- Style built-ins are `기본 프리셋 (한국어)` and `Basic Preset (Eng)`, containing exactly the respective Korean and English revision criteria supplied by the user. The following `사용 팁` commentary is not part of either preset.

- All four context options default to checked when available:
  - `시스템 프롬프트`: active prompt template's `plain/type2: main` blocks; legacy fallback is the current character override applied to `db.mainPrompt`. Jailbreak, CoT, global note, chat history, and persona text are excluded.
  - `캐릭터 설명`: current character name, `desc`, `personality`, and `scenario`.
  - `캐릭터 로어북`: enabled, non-folder, non-empty entries from `currentCharacter.globalLore`; chat-local lore is excluded because it is not one of the requested sources.
  - `모듈 로어북`: enabled, non-folder, non-empty entries from currently active modules returned by `getModuleLorebooksWithSources()`.
- Character-dependent checkboxes are disabled and annotated when no current character or matching data exists. The builder itself can still run from the system prompt and user instruction.
- Each request contains exactly two messages:

  ```text
  system:
  <instruction name="task_instruction" title="작업 지시 프롬프트">...</instruction>
  <instruction name="style_instruction" title="스타일 지시 프롬프트">...</instruction> // omitted when empty

  user:
  # 참고 컨텍스트
  <context name="system_prompt" title="시스템 프롬프트">...</context>
  <context name="character_description" title="캐릭터 설명">...</context>
  <context name="character_lorebook" title="캐릭터 로어북">...</context>
  <context name="module_lorebook" title="모듈 로어북">...</context>

  <draft name="draft" title="초안">...</draft>  // only when a draft exists

  # 사용자 OOC 지시
  ...
  ```

- Only checked, non-empty blocks are serialized. An over-limit request is reported as an error; context is never silently truncated.
- The current main model/preset is used with `useStreaming: false`, `noMultiGen: true`, `tools: []`, and prompt caching disabled. Closing, resetting, or pressing the in-progress button aborts the outstanding request.
- The result is an editable textarea headed `초안`. A successful request replaces the draft and clears the instruction field, enabling iterative instructions such as `초안을 고쳐`.
- `결과물 페르소나로 복사` is disabled for an empty draft. If the persona description is non-empty and differs, it asks for confirmation before replacing `personaPrompt`; after copying it syncs legacy global fields when applicable, requests an immediate save, shows a success notice, and leaves the builder open.

## File map

- Create `src/ts/personaBuilder.ts`: pure source filtering, system/character/lorebook formatting, request message construction, built-in prompts, and user-preset operations.
- Create `src/ts/personaBuilder.test.ts`: deterministic compiler and filtering tests.
- Create `src/lib/Others/PersonaPromptPresetEditor.svelte`: reusable task/style accordion, preset selector, and save/overwrite/delete controls.
- Create `src/lib/Others/PersonaBuilder.svelte`: nested modal, state, request lifecycle, editable draft, copy/reset controls.
- Create `src/lib/Others/PersonaBuilder.test.ts`: source-level UI connection contract matching existing UI tests.
- Modify `src/lib/Setting/Pages/PersonaSettings.svelte`: builder launch button and selected-persona copy callback.
- Modify `src/lang/ko.ts` and `src/lang/en.ts`: all visible labels, descriptions, validation/errors, confirmation, and success messages.
- Modify `src/ts/requestPurpose.ts`: add `persona-builder` so request logs identify the auxiliary call correctly.
- Modify `src/ts/storage/database.svelte.ts`: add the optional stable user-preset record type and database field.

### Task 1: Pure persona-builder compiler

**Files:**
- Create: `src/ts/personaBuilder.ts`
- Test: `src/ts/personaBuilder.test.ts`

- [ ] **Step 1: Write failing tests for source selection and message order**

  Cover these exact cases:

  1. Template `main` blocks win over legacy `mainPrompt`; jailbreak/CoT/global-note blocks are absent.
  2. Legacy character `systemPrompt` replaces `{{original}}` in `mainPrompt`.
  3. Character description contains name, `desc`, `personality`, and `scenario`, omitting empty fields.
  4. Disabled, folder, and empty lorebook entries are excluded while character and module sources remain separate.
  5. Unchecked sources never appear in the request.
  6. Non-empty output appears after reference context as `<draft name="draft" title="초안">`.
  7. Empty output omits the draft block.
  8. Empty task instruction or empty user instruction is rejected before a request is made; an empty style instruction is allowed.
  9. Both supplied style built-ins are present verbatim and the usage tips are absent.
  10. Save, overwrite, delete, built-in protection, duplicate-name handling, and kind isolation work on user presets.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `pnpm vitest run src/ts/personaBuilder.test.ts`

  Expected: FAIL because `src/ts/personaBuilder.ts` does not exist.

- [ ] **Step 3: Implement the pure compiler**

  Export these stable contracts:

  ```ts
  export const DEFAULT_PERSONA_BUILDER_TASK_PROMPT: string
  export const PERSONA_BUILDER_BUILTIN_PRESETS: readonly PersonaBuilderPromptPreset[]

  export interface PersonaBuilderSelections {
      systemPrompt: boolean
      characterDescription: boolean
      characterLorebook: boolean
      moduleLorebook: boolean
  }

  export interface PersonaBuilderSourceSnapshot {
      systemPrompt: string
      characterDescription: string
      characterLorebook: string
      moduleLorebook: string
  }

  export function collectPersonaBuilderSources(input: {
      database: Database
      character?: character | null
      moduleLorebooks: Array<{ scopeId: string; entry: loreBook }>
  }): PersonaBuilderSourceSnapshot

  export function buildPersonaBuilderMessages(input: {
      taskInstruction: string
      styleInstruction: string
      userInstruction: string
      draft: string
      selections: PersonaBuilderSelections
      sources: PersonaBuilderSourceSnapshot
  }): Array<{ role: 'system' | 'user'; content: string }>
  ```

  Escape literal closing `</context>` and `</draft>` sequences inside source data so a lorebook cannot break the block boundary. Preserve full source text and source order; do not token-truncate.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `pnpm vitest run src/ts/personaBuilder.test.ts`

  Expected: PASS.

### Task 2: Persona builder modal and request lifecycle

**Files:**
- Create: `src/lib/Others/PersonaBuilder.svelte`
- Create: `src/lib/Others/PersonaPromptPresetEditor.svelte`
- Create: `src/lib/Others/PersonaBuilder.test.ts`
- Modify: `src/ts/requestPurpose.ts`
- Modify: `src/ts/storage/database.svelte.ts`

- [ ] **Step 1: Write the failing UI connection test**

  Assert that the builder uses `ShDialog`, two `PersonaPromptPresetEditor` instances, four labeled checkboxes, an instruction textarea, an editable draft textarea, send/reset/copy controls, `AbortController`, `requestChatData`, and the compiler exports from Task 1. Assert that the reusable editor exposes a dropdown plus save-new, overwrite, and delete actions.

- [ ] **Step 2: Add request-log purpose**

  Add `'persona-builder'` to `RequestPurpose` and map it to `페르소나 빌더` in `requestPurposeLabels`.

- [ ] **Step 3: Implement `PersonaBuilder.svelte`**

  Component props:

  ```ts
  interface Props {
      open?: boolean
      personaName: string
      currentDescription: string
      onCopyDraft: (draft: string) => void | Promise<void>
  }
  ```

  On each open, snapshot the current database, character, and active-module lorebooks, compile source strings once, initialize available checkboxes, and focus the user instruction. Send with:

  ```ts
  requestChatData({
      formated: buildPersonaBuilderMessages(...),
      bias: {},
      currentChar: currentCharacter,
      useStreaming: false,
      noMultiGen: true,
      tools: [],
      disablePromptCache: true,
      logSource: 'other',
      logPurpose: 'persona-builder',
  }, 'model', abortController.signal)
  ```

  Accept only `type === 'success'`; trim and store the result, otherwise render a localized inline error. Disable conflicting actions during generation, and abort on close, reset, or component destruction.

- [ ] **Step 4: Run focused UI/compiler tests**

  Run: `pnpm vitest run src/lib/Others/PersonaBuilder.test.ts src/ts/personaBuilder.test.ts`

  Expected: PASS.

### Task 3: Integrate with the persona editor

**Files:**
- Modify: `src/lib/Setting/Pages/PersonaSettings.svelte`
- Modify: `src/lib/Setting/PersonaScopeConnections.test.ts`

- [ ] **Step 1: Extend the existing persona connection test**

  Assert that the builder button is inside the description section after the description resizer, opens `PersonaBuilder`, and the copy callback writes to the currently locked `editingPersona`.

- [ ] **Step 2: Add the launch button and copy callback**

  Add local `personaBuilderOpen` state. When opening, keep the current modal target fixed. The callback confirms replacement only when needed, assigns `editingPersona.personaPrompt`, calls `syncGlobalLegacyFields()`, awaits `requestImmediateSave()`, and emits the localized success notice.

- [ ] **Step 3: Run focused integration tests**

  Run: `pnpm vitest run src/lib/Setting/PersonaScopeConnections.test.ts src/lib/Others/PersonaBuilder.test.ts src/ts/personaBuilder.test.ts`

  Expected: PASS.

### Task 4: Korean and English UI copy

**Files:**
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] **Step 1: Add mirrored `personaManager.builder` keys**

  Add localized strings for: title, opening description, launch button, task/style prompt labels and help, preset selection/save/overwrite/delete/name/confirm/results, four source names and unavailable hints, instruction label/placeholder, draft title/placeholder, send, stop, reset, copy, overwrite confirmation, copied notice, missing task prompt, missing instruction, empty response, aborted request, and generic request failure.

- [ ] **Step 2: Run language/type validation**

  Run: `pnpm check`

  Expected: exit code 0 with no new Svelte or TypeScript errors.

### Task 5: Theme, accessibility, and final verification

**Files:**
- Verify only; no planned production file beyond Tasks 1-4.

- [ ] **Step 1: Verify dialog and keyboard behavior**

  Confirm title association, labels for every checkbox/textarea/button, Escape close behavior, restored focus, disabled/busy states, and mobile single-column layout. Use only declared `--color-*` tokens or existing Tailwind theme utilities.

- [ ] **Step 2: Run the theme contract**

  Run: `pnpm check:theme-tokens`

  Expected: PASS.

- [ ] **Step 3: Run all affected tests together**

  Run: `pnpm vitest run src/ts/personaBuilder.test.ts src/lib/Others/PersonaBuilder.test.ts src/lib/Setting/PersonaScopeConnections.test.ts src/ts/requestLog.test.ts`

  Expected: PASS.

- [ ] **Step 4: Review the final diff without touching unrelated work**

  Run: `git diff --check`

  Expected: no whitespace errors. Review only the files listed in this plan; preserve all pre-existing uncommitted changes, especially the existing edits in `src/lang/ko.ts` and `src/lang/en.ts`.
