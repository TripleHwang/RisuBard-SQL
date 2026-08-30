# Chat Scroll Anchor Implementation Plan

> **For agentic workers:** Implement inline in the current checkout; this repository explicitly forbids creating a worktree unless requested. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the currently read chat message at the same viewport offset while in-message assets or message DOM are replaced, with a default-on toggle under Environment > Accessibility > Scroll.

**Architecture:** Add a small DOM helper that captures a visible message by `data-chat-index` and restores its offset by scrolling only `.default-chat-screen`. `DefaultChatScreen.svelte` owns the observer/timers and bypasses restoration for genuinely appended replies when the user was already at the latest message, preserving the existing auto-scroll behavior.

**Tech Stack:** Svelte 5, TypeScript, Vitest, happy-dom.

---

### Task 1: Specify anchor behavior

**Files:**
- Create: `src/lib/ChatScreens/chatScrollAnchor.test.ts`
- Create: `src/lib/ChatScreens/ChatScrollAnchorIntegration.test.ts`

- [x] Write tests proving the top-visible message and offset are captured, offset drift scrolls only the chat container, and appended replies bypass restoration at the latest message.
- [x] Run `pnpm vitest run src/lib/ChatScreens/chatScrollAnchor.test.ts src/lib/ChatScreens/ChatScrollAnchorIntegration.test.ts` and confirm RED because the helper and integration do not exist.

### Task 2: Implement native scroll anchoring

**Files:**
- Create: `src/lib/ChatScreens/chatScrollAnchor.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`

- [x] Implement `captureChatScrollAnchor(container, contextKey, messageCount)` using visible `[data-chat-index]` rectangles.
- [x] Implement `restoreChatScrollAnchor(container, snapshot, contextKey, messageCount)` using `container.scrollTo({ top: container.scrollTop + delta })`, returning early for context changes, missing messages, stable positions, and appended replies at the latest message.
- [x] Observe child-list mutations and media load events, retry bounded corrections while layout settles, capture on user scroll, and cancel stale corrections on direct user interaction.

### Task 3: Add the accessibility setting

**Files:**
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/accessibilitySettingsData.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/help.en.ts`
- Modify: `src/lang/help.ko.ts`

- [x] Add optional `preserveChatScrollPosition`, normalize it to `true` on load, and place its check row in the Scroll tab.
- [x] Add English and Korean label/help text; other locales inherit English through the existing language merge.

### Task 4: Verify

- [x] Run the two focused Vitest files and confirm GREEN.
- [x] Run `pnpm check` and inspect `git diff --check` plus the scoped diff.
