# Arca Chat Log Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple, attractive modal that copies an entire chat or an inclusive message range in the existing Arca-compatible rich clipboard format.

**Architecture:** Keep range selection and final HTML composition in a small tested TypeScript module. The modal owns the interaction, renders one real `Chat.svelte` message at a time in an off-screen staging surface, reuses `exportArcaHtml`, and caches the finished clipboard payload before the explicit copy click. `DefaultChatScreen.svelte` opens the modal from the existing chat menu because it owns the full hydrated chat.

**Tech Stack:** Svelte 5, TypeScript, Vitest, existing `ShDialog`/`ShButton`, existing Arca export pipeline.

---

### Task 1: Range selection and log HTML composer

**Files:**
- Create: `src/ts/arcaChatLog.test.ts`
- Create: `src/ts/arcaChatLog.ts`

- [ ] **Step 1: Write the failing tests**

Cover active-message filtering, one-based inclusive range selection, range clamping, escaped headings, one shared footer, and plain-text ordering.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ts/arcaChatLog.test.ts`

Expected: FAIL because `src/ts/arcaChatLog.ts` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Expose `selectArcaLogMessages`, `buildArcaLogClipboardHtml`, and `buildArcaLogPlainText`. Use inline styles and escaped user content so the output remains portable when pasted into Arca.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/ts/arcaChatLog.test.ts`

Expected: PASS.

### Task 2: Native responsive modal

**Files:**
- Create: `src/lib/ChatScreens/ArcaChatLogDialog.test.ts`
- Create: `src/lib/ChatScreens/ArcaChatLogDialog.svelte`

- [ ] **Step 1: Write the failing shell test**

Assert that the component uses `ShDialog`, exposes whole-chat/range controls, has an isolated preview, stages the real `Chat` component, and writes one `ClipboardItem` containing both `text/html` and `text/plain`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/ChatScreens/ArcaChatLogDialog.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal modal**

Use a refined two-column desktop layout and single-column mobile layout. Keep only whole-chat/range selection, preview generation progress, cancel/close, and a primary copy button. Exclude comments and disabled messages automatically. Render selected messages sequentially in the off-screen stage, feed their bodies to the tested composer, and show the exact final HTML in the preview.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/ChatScreens/ArcaChatLogDialog.test.ts`

Expected: PASS.

### Task 3: Chat menu integration and localization

**Files:**
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`

- [ ] **Step 1: Add the chat-menu entry and modal state**

Add one “Arca chat log” menu item and render the modal beside the existing chat-level dialogs. Pass the current character, current chat, persona name, and persona icon.

- [ ] **Step 2: Add English and Korean labels**

Keep the labels short and action-oriented; other locales inherit English through the existing language merge.

- [ ] **Step 3: Run focused validation**

Run: `pnpm vitest run src/ts/arcaChatLog.test.ts src/lib/ChatScreens/ArcaChatLogDialog.test.ts src/lib/UI/GUI/ThemeTokenContract.test.ts`

Run: `pnpm check`

Expected: all commands pass with no new errors.

- [ ] **Step 4: Verify the UI flow**

Open the app, choose the chat menu entry, generate a whole-chat preview, switch to a bounded range, copy, and confirm the clipboard contains both rich HTML and plain text. Check desktop and narrow viewport layouts.

No commit is included because the repository already contains user-owned uncommitted work and the user did not request a commit.
