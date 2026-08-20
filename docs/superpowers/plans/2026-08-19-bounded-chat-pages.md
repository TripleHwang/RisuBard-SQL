# Bounded Chat Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound chat-renderer memory by showing one fixed message page at a time, make page size configurable, keep deep links and screenshots bounded, and transfer large chats from the server in validated chunks without breaking the full-array compatibility contract.

**Architecture:** A pure pagination module owns normalization, stable absolute-index page boundaries, and anchor relocation. `DefaultChatScreen` owns ephemeral page selection and passes absolute bounds to `Chats`, which mounts only that range. Node storage hydrates the existing full `Chat` compatibility object through a paged binary endpoint so transfer/decode spikes are bounded while legacy synchronous consumers continue to see `chat.message` as an array.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Express, CommonJS server helpers, msgpack RisuSave encoding.

---

### Task 1: Pure pagination contract

**Files:**
- Create: `src/ts/chatPagination.ts`
- Create: `src/ts/chatPagination.test.ts`

- [ ] **Step 1: Write failing tests** for size normalization, empty chats, exact page boundaries, latest page selection, message-to-page lookup, and anchor preservation.
- [ ] **Step 2: Run** `pnpm vitest run src/ts/chatPagination.test.ts` and confirm imports fail because the module does not exist.
- [ ] **Step 3: Implement** `normalizeChatPageSize`, `getChatPageCount`, `getChatPageBounds`, `getLatestChatPage`, and `getChatPageForMessage` with zero-based pages and end-exclusive bounds.
- [ ] **Step 4: Re-run** the targeted test and require all cases to pass.

The public contract is:

```ts
export const DEFAULT_CHAT_PAGE_SIZE = 30
export const MIN_CHAT_PAGE_SIZE = 10
export const MAX_CHAT_PAGE_SIZE = 200
export type ChatPageBounds = { page: number; pageCount: number; start: number; end: number }
export function normalizeChatPageSize(value: unknown): number
export function getChatPageCount(messageCount: number, pageSize: number): number
export function getChatPageBounds(messageCount: number, pageSize: number, page: number): ChatPageBounds
export function getLatestChatPage(messageCount: number, pageSize: number): number
export function getChatPageForMessage(messageIndex: number, messageCount: number, pageSize: number): number
```

### Task 2: Persisted page-size setting

**Files:**
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/accessibilitySettingsData.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`
- Create: `src/ts/chatPaginationSettings.test.ts`

- [ ] **Step 1: Write a failing source-contract test** requiring `chatPageSize` in the database interface/default normalization and settings manifest.
- [ ] **Step 2: Run** the targeted test and confirm the missing setting causes failure.
- [ ] **Step 3: Add** `chatPageSize?: number`, normalize it to 10–200 with default 30, add the number setting, and add Korean/English labels and help.
- [ ] **Step 4: Re-run** the targeted tests.

### Task 3: Hard one-page renderer and navigation

**Files:**
- Modify: `src/lib/ChatScreens/Chats.svelte`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Create: `src/lib/ChatScreens/ChatPaginationConnections.test.ts`

- [ ] **Step 1: Write failing connection tests** requiring absolute `pageStart`/`pageEnd`, bounded iteration, previous/next/latest controls, page reset by chat ID, deep-link page selection, and removal of additive `loadPages` scrolling.
- [ ] **Step 2: Run** the test and confirm the old cumulative renderer fails it.
- [ ] **Step 3: Replace** `loadPages` with derived page bounds. Start every newly selected chat on its latest page, preserve absolute indices passed to `Chat`, explicitly navigate pages, and render only one page.
- [ ] **Step 4: Make** `scrollToMessage(index)` select `getChatPageForMessage(index, ...)`, await render, then scroll to the target.
- [ ] **Step 5: Make** send/reroll paths return to the latest page when the active message list grows.
- [ ] **Step 6: Re-run** pagination and connection tests.

### Task 4: Bounded screenshot behavior

**Files:**
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Extend: `src/lib/ChatScreens/ChatPaginationConnections.test.ts`

- [ ] **Step 1: Add a failing assertion** that screenshot code never assigns `Infinity` or expands the rendered page.
- [ ] **Step 2: Run** the connection test and confirm failure against the current full-chat screenshot.
- [ ] **Step 3: Capture** only the current page, include the page number in the output filename, release each temporary canvas, and label the action as a current-page screenshot.
- [ ] **Step 4: Re-run** the connection test.

### Task 5: Chunked server hydration

**Files:**
- Create: `server/node/chat-content-page.cjs`
- Create: `server/node/chat-content-page.test.ts`
- Modify: `server/node/server.cjs`
- Modify: `src/ts/storage/nodeStorage.ts`
- Create: `src/ts/storage/chatContentPage.ts`
- Create: `src/ts/storage/chatContentPage.test.ts`

- [ ] **Step 1: Write failing server tests** for clamped offset/limit, metadata separation, exact slices, empty chats, and immutable source chats.
- [ ] **Step 2: Run** the server test and confirm the helper is missing.
- [ ] **Step 3: Implement** a pure page envelope `{ chat, messages, offset, total }` with a server limit of 10–500.
- [ ] **Step 4: Add** authenticated `GET /api/chat-content/:chaId/:chatIndex/page?offset=&limit=` using the same chat-ID mismatch and cold-storage checks as full hydration.
- [ ] **Step 5: Write failing client tests** for ordered page assembly and malformed/inconsistent envelope rejection.
- [ ] **Step 6: Implement** `assembleChatContentPages` and update `NodeStorage.fetchChatContent` to request pages, fall back to the legacy full endpoint when the page endpoint is unavailable, and normalize only the final assembled chat.
- [ ] **Step 7: Run** targeted client and server tests.

### Task 6: Verification and documentation alignment

**Files:**
- Modify: `project_wiki/file_native_user_data_architecture.md` only if the implemented behavior changes its canonical contract.

- [ ] **Step 1: Run** pagination, settings, connection, client assembly, and server helper tests together.
- [ ] **Step 2: Run** `pnpm check` and inspect every diagnostic touching changed files.
- [ ] **Step 3: Run** `pnpm build` to verify Svelte/Vite integration.
- [ ] **Step 4: Run** `git diff --check` and inspect the complete diff without changing unrelated worktree edits.
- [ ] **Step 5: Compare** the implementation against every task above and report any remaining compatibility limit explicitly.
