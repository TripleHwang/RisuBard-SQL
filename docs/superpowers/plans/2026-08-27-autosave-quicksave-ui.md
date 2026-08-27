# Autosave, Quicksave, and Save-Slot Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded autosaves, a single per-chat quicksave/quickload checkpoint, an inline composer toolbar, and a larger responsive save-slot workspace.

**Architecture:** Reserved per-chat save IDs distinguish quick and rotating auto slots without changing the durable save-slot format. Pure policy helpers decide cadence, rotation, and slot classification; ChatScreen owns save/load orchestration after generation is idle. The dialog presents auto slots in a one-row strip and ordinary slots in a square responsive grid with Quicksave fixed first.

**Tech Stack:** Svelte 5, TypeScript, existing Node save-slot service, Solar icons, Vitest

---

## Task 1: Define save kinds and autosave cadence

**Files:**
- Create: `src/ts/risubard/memorySavePolicy.ts`
- Create: `src/ts/risubard/memorySavePolicy.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`

- [ ] Write failing tests for `quickSaveId(chatId)`, rotating `autoSaveId(chatId, turn, interval, retention)`, slot classification, and cadence `turn >= 1 && (turn - 1) % interval === 0`.
- [ ] Run the policy test and verify the missing module failure.
- [ ] Implement bounded defaults of 5 turns and 5 retained autosaves, with integer normalization and per-chat reserved IDs.
- [ ] Add `risuBardAutosaveInterval`, `risuBardAutosaveRetention`, and `Chat.risuBardLastAutosaveTurn` persistence/defaults.
- [ ] Add Common Options number controls and localized help describing that interval 5 saves turns 1, 6, 11, and so on.
- [ ] Run policy, database normalization, settings connection, and type checks.

## Task 2: Add quick and automatic save orchestration

**Files:**
- Modify: `src/lib/ChatScreens/ChatScreen.svelte`
- Modify: `src/ts/risubard/memorySaveSlots.ts`
- Modify: `src/ts/risubard/memorySaveSlots.test.ts`
- Modify: `src/lib/SideBars/RisuBardSaveSlotsConnections.test.ts`

- [ ] Write failing tests for first quicksave creation, later quicksave overwrite, missing quickload handling, autosave turn selection, rotating overwrite, and retention cleanup.
- [ ] Run focused tests and verify failures are caused by the missing orchestration.
- [ ] Refactor `saveCurrentChat` to accept an explicit slot ID, overwrite flag, and silent mode while preserving manual dialog behavior.
- [ ] Implement quicksave by listing the current chat's slots, creating the reserved quick slot once, and overwriting only that slot thereafter.
- [ ] Implement quickload through the existing transactional load path with unsaved-chat confirmation and a clear missing-slot notice.
- [ ] Trigger autosave only after a completed non-streaming assistant turn and BardWiki generation is idle; persist the last successful autosave turn in the chat snapshot.
- [ ] Rotate among the configured number of auto IDs and delete stale auto slots when retention is reduced.
- [ ] Run focused client/server save tests and type checks.

## Task 3: Replace the floating shortcut with an inline four-action toolbar

**Files:**
- Modify: `src/lib/ChatScreens/RisuBardSaveLoadShortcuts.svelte`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lib/SideBars/RisuBardSaveSlotsConnections.test.ts`
- Create: `src/assets/solar-bold/diskette-bold.svg`
- Create: `src/assets/solar-bold/lightning-bold.svg`

- [ ] Update connection tests to require one inline toolbar directly above the message composer on desktop and mobile, with Save, Load, Quicksave, and Quickload buttons.
- [ ] Run the connection test and verify it fails against the floating two-button dock.
- [ ] Rebuild the shortcut component as a compact single-row toolbar using Solar save/load assets; overlay lightning on the diskette for Quicksave and on the load icon for Quickload.
- [ ] Remove drag/placement behavior and wire `onQuickSave`/`onQuickLoad` through every chat theme.
- [ ] Keep the Common Options visibility toggle and accessible labels/tooltips.
- [ ] Run component/connection tests and Svelte checks.

## Task 4: Redesign the responsive save-slot workspace

**Files:**
- Modify: `src/lib/SideBars/RisuBardSaveSlotsDialog.svelte`
- Modify: `src/lib/SideBars/RisuBardSaveSlotsDialog.test.ts`
- Modify: `src/lib/ChatScreens/ChatScreen.svelte`

- [ ] Write failing component tests for the character/chat breadcrumb, absent redundant title, auto strip, fixed Quicksave card, slot-kind filtering, and save/load actions.
- [ ] Add layout assertions for `91vh`, approximately `70.4rem`, full `100dvw × 100dvh` mobile geometry, square cards, and 5–7 desktop columns.
- [ ] Run dialog tests and verify the expected failures.
- [ ] Pass character and chat names into the dialog and render `Character / Chat` immediately left of the close button using the existing title typography.
- [ ] Remove the `채팅 저장하기`/`채팅 불러오기` heading while retaining accessible dialog naming.
- [ ] Split the file browser into a one-row autosave strip and an ordinary grid whose first card is always Quicksave, even before it exists.
- [ ] Remove the redundant current chat name from ordinary card presentation; show slot label, turn, and timestamp in square cards.
- [ ] Preserve selection, preview, rename/delete for manual slots, and transactional load/overwrite behavior.
- [ ] Run dialog, connection, save/load, and Svelte checks.

## Task 5: Document and verify the complete history policy

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/decision_log.md`
- Modify: affected authoritative documents found by exact reference search

- [ ] Document save/load as the only durable rewind boundary, protected evidence deletion, historical branch rejection, compact receipts, and bounded reboot recovery.
- [ ] Document manual, quick, and rotating auto save-slot behavior and the autosave cadence.
- [ ] Search authoritative docs for stale per-turn snapshot/undo and floating two-button shortcut claims and update only affected sources.
- [ ] Run targeted Vitest suites, `npm run check`, and `git diff --check`.
- [ ] Inspect the final diff and exclude concurrent unrelated changes from the handoff.
