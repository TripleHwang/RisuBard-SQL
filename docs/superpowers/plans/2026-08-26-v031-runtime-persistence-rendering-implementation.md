# v0.3.1 Runtime Persistence and Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound client startup, runtime memory, persistence work, and rendering work by the active screen instead of the total database and asset library.

**Architecture:** This plan depends on the approved metadata-first startup plan: Node SQL bootstrap, character-detail, and message-page endpoints must exist before Task 3. Normal Node writes become ID-scoped SQL commits produced by a Dirty Registry; the existing full-graph observer remains an idle compatibility audit only. Hydration, rendering, images, and optional feature modules use explicit bounded caches that saver mode can evict without losing dirty data.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest, Express, SQLite relational store, wasm-vips, browser Performance APIs.

---

## File map

- `src/ts/storage/sql/dirtyRegistry.ts` — mutation scopes, coalescing, retry-safe acknowledgement.
- `src/ts/storage/sql/sqlDirtyCommit.ts` — bounded `SqlCommit` serializer.
- `src/ts/storage/sql/sqlPersistenceRuntime.ts` — registry flush, conflict retry, idle legacy audit.
- `src/ts/storage/chatStorage.ts` — latest-page hydration and two-chat LRU.
- `src/ts/chatWindow.ts` — pure mounted-window/spacer calculations.
- `src/ts/markdown/streamRenderScheduler.ts` — one active-message update per animation frame.
- `src/ts/performance/{lruCache,saverMode,runtimeMetrics}.ts` — resource ownership/reclamation/measurement.
- `src/ts/media/assetUrl.ts` — original versus thumbnail URLs.
- `src/lib/ChatScreens/Chats.svelte` — keyed message window and anchor preservation.
- `src/lib/UI/VirtualCharacterList.svelte`, `src/lib/Mobile/MobileCharacters.svelte` — viewport-only character rows.
- `server/node/server.cjs` — cached WebP thumbnail route.

The prerequisite startup plan `docs/superpowers/plans/2026-08-26-v031-startup-hydration-implementation.md` owns `/api/sql/bootstrap`, `/api/sql/characters/:id`, and `/api/sql/chats/:id/messages`; it must be green before Task 3. It also owns the corresponding `NodeSqliteStorage.loadBootstrap` and page-fetch contract.

### Task 1: Create the Dirty Registry

**Files:**

- Create: `src/ts/storage/sql/dirtyRegistry.ts`
- Test: `src/ts/storage/sql/dirtyRegistry.test.ts`

- [ ] **Step 1: Write the failing coalescing and acknowledgement tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { DirtyRegistry } from './dirtyRegistry'

describe('DirtyRegistry', () => {
  it('coalesces one message and preserves its manifest', () => {
    const registry = new DirtyRegistry(() => Promise.resolve())
    registry.markMessage('chat-a', 'message-a')
    registry.markMessage('chat-a', 'message-a')
    registry.markMessageManifest('chat-a')
    expect(registry.takeSnapshot()).toMatchObject({
      messages: [{ chatId: 'chat-a', messageIds: ['message-a'] }],
      messageManifestChatIds: ['chat-a'],
    })
  })
  it('does not acknowledge edits made while a commit is in flight', () => {
    const registry = new DirtyRegistry(() => Promise.resolve())
    registry.markRoot('language')
    const old = registry.takeSnapshot()
    registry.markRoot('theme')
    registry.acknowledge(old)
    expect(registry.takeSnapshot().rootKeys).toEqual(['theme'])
  })
  it('uses one scheduled flush timer', async () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockResolvedValue(undefined)
    const registry = new DirtyRegistry(flush)
    registry.markRoot('language'); registry.schedule(300); registry.schedule(300)
    await vi.advanceTimersByTimeAsync(300)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/storage/sql/dirtyRegistry.test.ts`

Expected: FAIL because `./dirtyRegistry` does not exist.

- [ ] **Step 3: Implement deterministic mutation scopes**

```ts
export type DirtySnapshot = {
  rootKeys: string[]; characterIds: string[]
  chats: Array<{ characterId: string; chatId: string; manifest: boolean }>
  messages: Array<{ chatId: string; messageIds: string[] }>
  messageManifestChatIds: string[]
  messageDeletes: Array<{ chatId: string; messageIds: string[] }>
  pluginStorageKeys: string[]; presetIds: string[]
}

export class DirtyRegistry {
  constructor(private readonly onFlush: () => Promise<void>) {}
  markRoot(key: string): void
  markCharacter(characterId: string): void
  markChat(characterId: string, chatId: string, manifest?: boolean): void
  markMessage(chatId: string, messageId: string): void
  markMessageManifest(chatId: string): void
  markMessageDeleted(chatId: string, messageId: string): void
  markPluginStorage(key: string): void
  markPreset(id: string): void
  takeSnapshot(): DirtySnapshot
  acknowledge(snapshot: DirtySnapshot): void
  schedule(delay?: number): void
  flushNow(): Promise<void>
}
```

Implement every backing collection as a `Set` or `Map`; sort keys in `takeSnapshot`. `acknowledge` must delete only values named in the snapshot. `flushNow` clears its timer before awaiting `onFlush`; it does not clear dirty state itself.

- [ ] **Step 4: Run the GREEN test**

Run: `pnpm vitest run src/ts/storage/sql/dirtyRegistry.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/ts/storage/sql/dirtyRegistry.ts src/ts/storage/sql/dirtyRegistry.test.ts
git commit -m "feat(storage): add coalesced dirty registry"
```

### Task 2: Serialize row-scoped commits

**Files:**

- Create: `src/ts/storage/sql/sqlDirtyCommit.ts`
- Test: `src/ts/storage/sql/sqlDirtyCommit.test.ts`
- Modify: `src/ts/storage/sql/sqlCommit.ts`
- Modify: `src/ts/storage/sql/sqliteCommit.ts`
- Modify: `src/ts/storage/sql/nodeSqliteStorage.ts`
- Modify: `src/ts/storage/sql/webSqliteStorage.ts`

- [ ] **Step 1: Write failing one-row and deletion tests**

```ts
it('serializes only a dirty message row in a 20,000-message chat', () => {
  const db = fixtureDatabaseWithMessages(20_000)
  const commit = buildSqlDirtyCommit(db, dirtyMessage('chat-a', 'm-19999'), 7)
  expect(commit.messages).toHaveLength(1)
  expect(commit.messages[0]).toMatchObject({ id: 'm-19999', chatId: 'chat-a', position: 19_999 })
  expect(commit.messageManifests).toEqual([])
})
it('uses a manifest and delete list without sending siblings', () => {
  const commit = buildSqlDirtyCommit(fixtureAfterDelete(), dirtyDelete('chat-a', 'm-2'), 7)
  expect(commit.messageDeletes).toEqual([{ chatId: 'chat-a', ids: ['m-2'] }])
  expect(commit.messageManifests).toEqual([{ chatId: 'chat-a', ids: ['m-1', 'm-3'] }])
  expect(commit.messages).toEqual([])
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/storage/sql/sqlDirtyCommit.test.ts`

Expected: FAIL because `buildSqlDirtyCommit` does not exist.

- [ ] **Step 3: Implement the bounded serializer**

```ts
export function buildSqlDirtyCommit(database: Database, dirty: DirtySnapshot, baseRevision: number): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, 'dirty-sync')
  for (const key of dirty.rootKeys) {
    const value = (database as Record<string, unknown>)[key]
    if (value === undefined) commit.root.deletes.push(key)
    else commit.root.upserts.push({ key, value })
  }
  // Find the requested chat by stable id, calculate message position only in that chat,
  // and add only requested message IDs. Add manifests/deletions exactly from dirty.
  return commit
}
```

Use `sqlCharacterData`, `sqlChatData`, and `sqlMessageData`; never call `buildSqlDeltaCommit` here. If supporting character/chat deletion requires new commit fields, add explicit `characterDeletes` / `chatDeletes` fields and update `applySqliteCommit` plus both storage backends in this same task.

- [ ] **Step 4: Run GREEN plus existing commit tests**

Run: `pnpm vitest run src/ts/storage/sql/sqlDirtyCommit.test.ts src/ts/storage/sql/sqlCommit.test.ts src/ts/storage/sql/sqlDelta.test.ts src/ts/storage/sql/nodeSqliteStorage.test.ts`

Expected: PASS, including a single message upsert from the 20,000-message fixture.

- [ ] **Step 5: Commit**

```powershell
git add src/ts/storage/sql/dirtyRegistry.ts src/ts/storage/sql/sqlDirtyCommit.ts src/ts/storage/sql/sqlDirtyCommit.test.ts src/ts/storage/sql/sqlCommit.ts src/ts/storage/sql/sqliteCommit.ts src/ts/storage/sql/nodeSqliteStorage.ts src/ts/storage/sql/webSqliteStorage.ts
git commit -m "feat(storage): build row-scoped SQL commits"
```

### Task 3: Make normal Node persistence registry-driven and audit legacy writes at idle

**Files:**

- Create: `src/ts/storage/sql/sqlPersistenceRuntime.ts`
- Test: `src/ts/storage/sql/sqlPersistenceRuntime.test.ts`
- Modify: `src/ts/storage/sql/sqlBootstrap.ts`
- Modify: `src/ts/globalApi.svelte.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/process/{command,scriptings,triggers}.ts`
- Modify: `src/ts/process/files/multisend.ts`
- Modify: `src/lib/ChatScreens/{Chat,DefaultChatScreen,ChatScreen}.svelte`
- Modify: `src/ts/characters.ts`

- [ ] **Step 1: Write failing hot-path tests**

```ts
it('commits a marked message without a full database clone', async () => {
  const storage = fakeStorageAtRevision(3)
  activateSqlStorage(storage, fixtureDatabaseWithMessages(20_000))
  markSqlMessageDirty('chat-a', 'm-19999')
  await flushSqlDirtyChanges()
  expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
    baseRevision: 3, messages: [expect.objectContaining({ id: 'm-19999' })],
  }))
})
it('schedules, rather than immediately runs, compatibility audit', () => {
  const audit = vi.fn()
  scheduleSqlCompatibilityAudit(audit)
  expect(audit).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/storage/sql/sqlPersistenceRuntime.test.ts src/ts/storage/sql/sqlBootstrap.test.ts`

Expected: FAIL because runtime persistence exports do not exist.

- [ ] **Step 3: Implement the runtime facade**

```ts
export function markSqlMessageDirty(chatId: string, messageId: string, immediate = false): void
export function markSqlMessageDeleted(chatId: string, messageId: string): void
export function markSqlMessageManifestDirty(chatId: string): void
export function markSqlChatDirty(characterId: string, chatId: string, manifest = false): void
export function markSqlCharacterDirty(characterId: string): void
export async function flushSqlDirtyChanges(): Promise<void>
export function scheduleSqlCompatibilityAudit(run?: () => Promise<void> | void): void
```

`flushSqlDirtyChanges` snapshots the registry, builds one `SqlCommit` with `activeStorage.getRevision()`, commits it, and acknowledges only on success. On `SqlRevisionConflictError`, call the prerequisite targeted entity read APIs for every dirty entity, merge only those rows, keep unresolved scopes dirty, and retry once. It must never fetch `/api/sql/snapshot` during ordinary conflict recovery.

Change `activateSqlStorage` in `sqlBootstrap.ts` to hold the live database reference, not `safeStructuredClone(database)`. Replace normal `syncActiveSqlDatabase` behavior with `flushSqlDirtyChanges`.

- [ ] **Step 4: Mark every core direct mutation**

Use these exact calls after the mutation, never during `hydrationInFlight` or `hydrationJustApplied`:

```ts
// src/ts/process/index.svelte.ts, stream append/update/finalize
markSqlMessageDirty(currentChat.id!, currentChat.message[msgIndex].chatId!, generationFinished)
// src/lib/ChatScreens/Chat.svelte, edit/toggle
markSqlMessageDirty(chat.id!, message.chatId!, true)
// before splice/filter removal
markSqlMessageDeleted(chat.id!, removed.chatId!); markSqlMessageManifestDirty(chat.id!)
// chat add/remove/reorder
markSqlChatDirty(character.chaId!, chat.id!, true)
```

Apply it to `src/ts/process/command.ts`, `scriptings.ts`, `triggers.ts`, `files/multisend.ts`, `characters.ts`, and the named Svelte files. A whole array replacement must mark its message manifest plus changed/new IDs, not every untouched message.

- [ ] **Step 5: Move legacy persistence to a compatibility-only idle audit**

In `globalApi.svelte.ts`, leave the existing `deepTouch` machinery available for plugins that mutate raw DB objects, but call it from `requestIdleCallback(..., { timeout: 5000 })` or a 1-second timeout fallback. Convert its detected delta to Dirty Registry marks. For Node SQL normal saves, do not run `encoder.set`, `patcher.set`, `safeStructuredClone(db)`, or `buildSqlDeltaCommit` in the 300–500ms typing/streaming path. Retain full projection for imports, explicit export/backups, recovery, and a debounced idle projection.

- [ ] **Step 6: Run GREEN tests**

Run: `pnpm vitest run src/ts/storage/sql/sqlPersistenceRuntime.test.ts src/ts/storage/sql/sqlBootstrap.test.ts src/ts/process/request/jobRecovery.test.ts src/lib/ChatScreens/ChatPaginationConnections.test.ts`

Expected: PASS. Add source-contract tests proving the streaming path calls `markSqlMessageDirty` and does not directly invoke `syncActiveSqlDatabase`.

- [ ] **Step 7: Commit**

```powershell
git add src/ts/storage/sql/sqlPersistenceRuntime.ts src/ts/storage/sql/sqlPersistenceRuntime.test.ts src/ts/storage/sql/sqlBootstrap.ts src/ts/globalApi.svelte.ts src/ts/process/index.svelte.ts src/ts/process/command.ts src/ts/process/scriptings.ts src/ts/process/triggers.ts src/ts/process/files/multisend.ts src/lib/ChatScreens/Chat.svelte src/lib/ChatScreens/DefaultChatScreen.svelte src/lib/ChatScreens/ChatScreen.svelte src/ts/characters.ts
git commit -m "feat(storage): persist normal mutations by dirty scope"
```

### Task 4: Hydrate recent pages and cap the runtime at two chats

**Files:**

- Modify: `src/ts/storage/chatStorage.ts`
- Modify: `src/ts/storage/sql/nodeSqliteStorage.ts`
- Test: `src/ts/storage/chatStorage.test.ts`
- Test: `src/ts/storage/sql/nodeSqliteStorage.test.ts`

- [ ] **Step 1: Write failing LRU tests**

```ts
it('keeps only active and most-recent chat after a third hydration', async () => {
  const cache = new ChatHydrationCache({ maxChats: 2, flush: vi.fn().mockResolvedValue(undefined) })
  await cache.touch('char-a', 'chat-1'); await cache.touch('char-a', 'chat-2')
  await cache.touch('char-a', 'chat-3', { activeChatId: 'chat-3' })
  expect(cache.ids()).toEqual(['char-a/chat-2', 'char-a/chat-3'])
})
it('refuses eviction when dirty data cannot flush', async () => {
  const cache = new ChatHydrationCache({ maxChats: 1, flush: vi.fn().mockRejectedValue(new Error('offline')) })
  await cache.touch('char-a', 'chat-1', { dirty: true })
  await expect(cache.touch('char-a', 'chat-2', { activeChatId: 'chat-2' })).rejects.toThrow('offline')
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/storage/chatStorage.test.ts`

Expected: FAIL because `ChatHydrationCache` does not exist.

- [ ] **Step 3: Implement page-first hydration**

```ts
export class ChatHydrationCache {
  constructor(private readonly options: { maxChats: number; flush: () => Promise<void> }) {}
  async touch(characterId: string, chatId: string, options: { activeChatId?: string; dirty?: boolean } = {}): Promise<void>
  ids(): string[]
}
export async function hydrateRecentChatPage(chats: Chat[], index: number, chaId: string, limit = 40): Promise<Chat | null>
export async function evictHydratedChats(activeChatId: string): Promise<void>
```

`hydrateRecentChatPage` calls `loadChatMessagePage(chat.id, undefined, 40)`; it applies `message`, `messageOffset`, `messageTotal`, `messagesFullyLoaded`, and `messagesLoaded` under the existing hydration suppression sets. LRU eviction flushes first, then replaces a full chat with `stubToPlaceholder(chatToStub(chat))`; it clears the message array and registered per-chat markdown/image cache ownership.

- [ ] **Step 4: Run GREEN tests**

Run: `pnpm vitest run src/ts/storage/chatStorage.test.ts src/ts/storage/sql/nodeSqliteStorage.test.ts src/ts/storage/chatContentPage.test.ts`

Expected: PASS; Node storage uses message-page API, not `current()`/snapshot.

- [ ] **Step 5: Commit**

```powershell
git add src/ts/storage/chatStorage.ts src/ts/storage/chatStorage.test.ts src/ts/storage/sql/nodeSqliteStorage.ts src/ts/storage/sql/nodeSqliteStorage.test.ts
git commit -m "feat(chat): bound hydrated chats to an LRU"
```

### Task 5: Window the chat DOM and preserve scroll anchors

**Files:**

- Create: `src/ts/chatWindow.ts`
- Test: `src/ts/chatWindow.test.ts`
- Modify: `src/lib/ChatScreens/Chats.svelte`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Test: `src/lib/ChatScreens/ChatPaginationConnections.test.ts`

- [ ] **Step 1: Write RED window tests**

```ts
it('caps normal and saver windows', () => {
  expect(getChatWindow({ total: 200, anchorIndex: 120, limit: 60 })).toMatchObject({ start: 90, end: 150, beforeCount: 90, afterCount: 50 })
  expect(getChatWindow({ total: 200, anchorIndex: 120, limit: 40 })).toMatchObject({ start: 100, end: 140 })
})
it('estimates spacers from measured row heights', () => {
  expect(estimateSpacerHeight([20, 30], 5, 24)).toBe(125)
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/chatWindow.test.ts`

Expected: FAIL because `./chatWindow` does not exist.

- [ ] **Step 3: Implement pure bounds and stable keys**

```ts
export function getChatWindow({ total, anchorIndex, limit }: { total: number; anchorIndex: number; limit: 60 | 40 }) {
  const start = Math.max(0, Math.min(total - limit, anchorIndex - Math.floor(limit / 2)))
  const end = Math.min(total, start + limit)
  return { start, end, beforeCount: start, afterCount: total - end }
}
export function estimateSpacerHeight(measured: number[], count: number, fallback = 24): number {
  return (measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : fallback) * count
}
```

In `Chats.svelte`, replace numeric `hashCode` ownership with `Map<string, ChatInstance>` keyed by `message.chatId ?? \`${index}:${message.role}\` `. Render top/bottom measured spacer divs. Preserve the active composer and actively streamed message if they lie on a boundary.

- [ ] **Step 4: Add contiguous older-page loading with anchor compensation**

```ts
async function loadOlderMessages(chatId: string, before: number) {
  const anchor = firstVisibleMessageAnchor(scroller)
  const page = await storage.loadChatMessagePage(chatId, before, 40)
  prependContiguousPage(page)
  await tick()
  restoreMessageAnchor(scroller, anchor)
}
```

Capture the first visible message ID and its `getBoundingClientRect().top` before prepend. After Svelte settles, compensate `scrollTop` by the same message’s new top delta. Reject a page with changed total/non-contiguous offset through `assembleChatContentPages`.

- [ ] **Step 5: Run GREEN tests**

Run: `pnpm vitest run src/ts/chatWindow.test.ts src/ts/storage/chatContentPage.test.ts src/lib/ChatScreens/ChatPaginationConnections.test.ts`

Expected: PASS. Add a source/component contract that normal mounted messages are ≤60 and saver mode passes 40.

- [ ] **Step 6: Commit**

```powershell
git add src/ts/chatWindow.ts src/ts/chatWindow.test.ts src/lib/ChatScreens/Chats.svelte src/lib/ChatScreens/DefaultChatScreen.svelte src/lib/ChatScreens/ChatPaginationConnections.test.ts
git commit -m "feat(chat): window message DOM with stable anchors"
```

### Task 6: Schedule streaming Markdown once per animation frame

**Files:**

- Create: `src/ts/markdown/streamRenderScheduler.ts`
- Test: `src/ts/markdown/streamRenderScheduler.test.ts`
- Modify: `src/lib/ChatScreens/Chats.svelte`
- Modify: `src/lib/ChatScreens/Chat.svelte`

- [ ] **Step 1: Write failing RAF scheduler tests**

```ts
it('renders the last active-message update once per frame', () => {
  const render = vi.fn(); const scheduler = new StreamRenderScheduler(render, requestAnimationFrame)
  scheduler.schedule('chat-a', 'm-1', 'a'); scheduler.schedule('chat-a', 'm-1', 'ab')
  runAnimationFrame()
  expect(render).toHaveBeenCalledExactlyOnceWith('chat-a', 'm-1', 'ab')
})
it('flushes the final update synchronously', () => {
  const render = vi.fn(); const scheduler = new StreamRenderScheduler(render, requestAnimationFrame)
  scheduler.schedule('chat-a', 'm-1', 'partial'); scheduler.schedule('chat-a', 'm-1', 'final')
  scheduler.flushNow()
  expect(render).toHaveBeenCalledExactlyOnceWith('chat-a', 'm-1', 'final')
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/markdown/streamRenderScheduler.test.ts`

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the scheduler and wire active streaming only**

```ts
export class StreamRenderScheduler {
  private pending = new Map<string, [string, string, string]>(); private frame = 0
  constructor(private readonly render: (chatId: string, messageId: string, text: string) => void, private readonly raf = requestAnimationFrame) {}
  schedule(chatId: string, messageId: string, text: string) {
    this.pending.set(\`${chatId}\\u0000${messageId}\`, [chatId, messageId, text])
    if (!this.frame) this.frame = this.raf(() => this.flush())
  }
  flush() { this.frame = 0; for (const item of this.pending.values()) this.render(...item); this.pending.clear() }
  flushNow() { this.flush() }
}
```

Keep the existing request-layer 50ms stream coalescing. `Chats.svelte` uses this scheduler only for the active streaming message and reuses mounted parsed output for all others. Generation completion calls `flushNow` before its immediate dirty commit.

- [ ] **Step 4: Run GREEN tests**

Run: `pnpm vitest run src/ts/markdown/streamRenderScheduler.test.ts src/ts/process/request/shared.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/ts/markdown/streamRenderScheduler.ts src/ts/markdown/streamRenderScheduler.test.ts src/lib/ChatScreens/Chats.svelte src/lib/ChatScreens/Chat.svelte
git commit -m "perf(chat): batch streaming markdown renders"
```

### Task 7: Cache WebP thumbnails and virtualize character rows

**Files:**

- Modify: `server/node/server.cjs`
- Create: `server/node/asset-thumbnail.test.ts`
- Create: `src/ts/media/assetUrl.ts`
- Test: `src/ts/media/assetUrl.test.ts`
- Create: `src/lib/UI/VirtualCharacterList.svelte`
- Modify: `src/lib/Mobile/MobileCharacters.svelte`
- Test: `src/lib/Mobile/MobileCharacters.test.ts`

- [ ] **Step 1: Write failing thumbnail and virtual-list tests**

```ts
it('serves immutable WebP thumbnails and returns 304 for matching ETag', async () => {
  const first = await requestAssetThumb('assets/portrait.png')
  expect(first.status).toBe(200); expect(first.headers.get('content-type')).toBe('image/webp')
  expect((await requestAssetThumb('assets/portrait.png', first.headers.get('etag')!)).status).toBe(304)
})
it('mounts no more than visible rows plus overscan', () => {
  expect(visibleRange({ count: 200, scrollTop: 0, height: 680, rowHeight: 68, overscan: 8 })).toEqual({ start: 0, end: 18 })
})
```

- [ ] **Step 2: Run the RED tests**

Run separately:

```powershell
pnpm vitest run src/ts/media/assetUrl.test.ts src/lib/Mobile/MobileCharacters.test.ts
pnpm vitest run --config vitest.config.server.ts server/node/asset-thumbnail.test.ts
```

Expected: FAIL because routes/helpers/components do not exist.

- [ ] **Step 3: Implement thumbnail cache and URL helper**

```js
app.get('/api/asset/:hexKey/thumb', sessionAuthMiddleware, async (req, res) => {
  const key = decodeHexKey(req.params.hexKey)
  if (!key.startsWith('assets/') || !THUMB_IMAGE_EXTS.has(path.extname(key).slice(1).toLowerCase())) return res.status(404).end()
  const updatedAt = kvGetUpdatedAt(key); if (updatedAt === null) return res.status(404).end()
  const etag = \`"thumb-${updatedAt}"\`
  if (req.headers['if-none-match'] === etag) return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
  const cacheKey = thumbnailCacheKey(key, updatedAt, THUMB_MAX_SIDE, THUMB_QUALITY)
  const image = kvGet(cacheKey) ?? await generateAndStoreThumbnail(key, cacheKey)
  res.type('image/webp').set({ ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' }).send(image)
})
```

Use SHA-256 cache keys, an `assets/` allowlist, source-derived invalidation, and decoded-pixel limits before vips. Refactor existing `inlay_thumb/` generator through the same bounded helper.

```ts
export function getAssetUrl(path: string, options: { variant: 'full' | 'thumbnail'; node: boolean }): string | null {
  if (!path || (options.variant === 'thumbnail' && !/\\.(png|jpe?g|gif|webp)$/i.test(path))) return null
  const base = \`/api/asset/${Buffer.from(path, 'utf8').toString('hex')}\`
  return options.node ? options.variant === 'thumbnail' ? \`${base}/thumb\` : base : null
}
```

- [ ] **Step 4: Implement virtual rows**

```ts
export function visibleRange(input: { count: number; scrollTop: number; height: number; rowHeight: number; overscan: number }) {
  return {
    start: Math.max(0, Math.floor(input.scrollTop / input.rowHeight) - input.overscan),
    end: Math.min(input.count, Math.ceil((input.scrollTop + input.height) / input.rowHeight) + input.overscan),
  }
}
```

`VirtualCharacterList.svelte` uses a total-height shell and translated visible range. `MobileCharacters.svelte` derives filtered/sorted entries once, identifies items by `chaId`, uses `loading="lazy"` / `decoding="async"`, and falls back to existing `getCharImage` outside Node. Preserve keyboard focus and selected-character behavior.

- [ ] **Step 5: Run GREEN tests**

Run separately:

```powershell
pnpm vitest run src/ts/media/assetUrl.test.ts src/lib/Mobile/MobileCharacters.test.ts
pnpm vitest run --config vitest.config.server.ts server/node/asset-thumbnail.test.ts
```

Expected: PASS; 200 rows yield no more than 30 mounted entries for a 10-row viewport.

- [ ] **Step 6: Commit**

```powershell
git add server/node/server.cjs server/node/asset-thumbnail.test.ts src/ts/media/assetUrl.ts src/ts/media/assetUrl.test.ts src/lib/UI/VirtualCharacterList.svelte src/lib/Mobile/MobileCharacters.svelte src/lib/Mobile/MobileCharacters.test.ts
git commit -m "perf(media): cache thumbnails and virtualize characters"
```

### Task 8: Reclaim memory automatically and defer optional boot work

**Files:**

- Create: `src/ts/performance/lruCache.ts`
- Test: `src/ts/performance/lruCache.test.ts`
- Create: `src/ts/performance/saverMode.ts`
- Test: `src/ts/performance/saverMode.test.ts`
- Modify: `src/ts/bootstrap.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/App.svelte`

- [ ] **Step 1: Write failing saver order tests**

```ts
it('flushes before eviction and keeps the active chat', async () => {
  const calls: string[] = []
  const saver = new SaverModeCoordinator({
    flush: async () => calls.push('flush'), evictChats: async keep => calls.push(\`evict:${keep}\`),
    setWindow: n => calls.push(\`window:${n}\`), clearCaches: () => calls.push('clear'),
  })
  await saver.enter('background', 'chat-active')
  expect(calls).toEqual(['flush', 'evict:chat-active', 'window:40', 'clear'])
})
it('never evicts when flush rejects', async () => {
  const calls: string[] = []
  const saver = new SaverModeCoordinator({
    flush: async () => { calls.push('flush'); throw new Error('offline') },
    evictChats: async () => calls.push('evict'), setWindow: () => calls.push('window'), clearCaches: () => calls.push('clear'),
  })
  await expect(saver.enter('background', 'chat-active')).rejects.toThrow('offline')
  expect(calls).toEqual(['flush'])
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/performance/lruCache.test.ts src/ts/performance/saverMode.test.ts`

Expected: FAIL because the performance modules do not exist.

- [ ] **Step 3: Implement caches and ordered saver mode**

```ts
export class BoundedLruCache<K, V> {
  constructor(private readonly maxEntries: number, private readonly onEvict?: (value: V) => void) {}
  get(key: K): V | undefined
  set(key: K, value: V): void
  shrinkTo(maxEntries: number): void
  clear(): void
}
export class SaverModeCoordinator {
  constructor(private readonly actions: { flush(): Promise<void>; evictChats(keepChatId: string): Promise<void>; setWindow(limit: 40 | 60): void; clearCaches(): void }) {}
  async enter(_reason: 'import'|'export'|'cache-budget'|'long-task'|'background', activeChatId: string) {
    await this.actions.flush(); await this.actions.evictChats(activeChatId); this.actions.setWindow(40); this.actions.clearCaches()
  }
  leave(): void { this.actions.setWindow(60) }
}
```

Register Markdown, preview, editor, thumbnail, full-image, and object URL caches. Any object URL cache value’s `onEvict` calls `URL.revokeObjectURL`. Trigger saver mode on import/export, cache quota, page hide/background, and supported repeated Long Tasks; Safari fallback depends on deterministic cache limits/lifecycle signals, not `performance.memory`.

- [ ] **Step 4: Defer modules only after interactive paint**

After `loadedStore.set(true)` in `bootstrap.ts`, schedule optional work:

```ts
requestAnimationFrame(() => requestAnimationFrame(() => {
  void loadPlugins().catch(console.error)
  void moduleUpdate().catch(console.error)
  void checkRisuUpdate().catch(console.error)
  void initModelJobRecovery().catch(console.error)
  setTimeout(() => { void cleanChunks().catch(console.error) }, 5_000)
}))
```

Use existing dynamic-loader style such as `loadPlaygroundMenu` for settings-only editor/modal modules in `App.svelte`; do not split first-chat composer, core navigation, or active chat components.

- [ ] **Step 5: Run GREEN checks**

Run separately:

```powershell
pnpm vitest run src/ts/performance/lruCache.test.ts src/ts/performance/saverMode.test.ts
pnpm check
```

Expected: PASS and `svelte-check found 0 errors and 0 warnings`.

- [ ] **Step 6: Commit**

```powershell
git add src/ts/performance/lruCache.ts src/ts/performance/lruCache.test.ts src/ts/performance/saverMode.ts src/ts/performance/saverMode.test.ts src/ts/bootstrap.ts src/lib/ChatScreens/DefaultChatScreen.svelte src/App.svelte
git commit -m "perf(runtime): reclaim caches and defer optional startup"
```

### Task 9: Instrument runtime behavior and run focused integration gates

**Files:**

- Create: `src/ts/performance/runtimeMetrics.ts`
- Test: `src/ts/performance/runtimeMetrics.test.ts`
- Modify: `src/ts/bootstrap.ts`
- Modify: `src/ts/storage/sql/sqlPersistenceRuntime.ts`

- [ ] **Step 1: Write a failing privacy-safe metrics test**

```ts
it('records fixed names only', () => {
  const marks: string[] = []
  const metrics = createRuntimeMetrics({ mark: name => marks.push(name), measure: vi.fn() } as Performance)
  metrics.start('bootstrap'); metrics.end('bootstrap')
  expect(marks).toEqual(['risu:bootstrap:start', 'risu:bootstrap:end'])
})
```

- [ ] **Step 2: Run the RED test**

Run: `pnpm vitest run src/ts/performance/runtimeMetrics.test.ts`

Expected: FAIL because `runtimeMetrics` does not exist.

- [ ] **Step 3: Implement fixed-name marks and explicit fallback**

```ts
export function createRuntimeMetrics(api: Pick<Performance, 'mark' | 'measure'> = performance) {
  return {
    start(name: 'bootstrap'|'character-hydration'|'message-page'|'dirty-commit'|'stream-render') { api.mark(\`risu:${name}:start\`) },
    end(name: 'bootstrap'|'character-hydration'|'message-page'|'dirty-commit'|'stream-render') { api.mark(\`risu:${name}:end\`); api.measure(\`risu:${name}\`, \`risu:${name}:start\`, \`risu:${name}:end\`) },
  }
}
```

On bootstrap-query failure before first paint, show an explicit degraded-mode notice and use the old snapshot route once. On row-commit failure, retain dirty scopes and hydrated data for retry; never silently turn the failure into an unsafe full write.

- [ ] **Step 4: Run the full suite**

Run separately:

```powershell
pnpm check
pnpm build
pnpm test
pnpm test:compat
pnpm test:server
```

Expected: every command exits 0. Record pre-existing non-fatal Vite warnings separately.

- [ ] **Step 5: Run release-profile manual tests**

1. Generate a non-private fixture with 200 characters and 20,000 messages.
2. On iPhone 13+/iOS 17 Safari/PWA through Tailscale, perform ten cold starts; target first interactive list ≤5 seconds and require p95 ≤8 seconds.
3. Switch chats; require recent message visibility p95 ≤1.5 seconds.
4. Scroll to load older pages and stream a response; require no lost draft/scroll-anchor jump.
5. Repeat chat/image navigation for 30 minutes; require no WebKit termination/reload.
6. Run Android Chrome import and chat regressions.

- [ ] **Step 6: Commit**

```powershell
git add src/ts/performance/runtimeMetrics.ts src/ts/performance/runtimeMetrics.test.ts src/ts/bootstrap.ts src/ts/storage/sql/sqlPersistenceRuntime.ts
git commit -m "test(perf): add v0.3.1 runtime release gates"
```

## Plan self-review

- Coverage: dirty row commits and plugin compatibility audit are Tasks 1–3; bounded hydration/saver mode are Tasks 4 and 8; 40/60 DOM and anchoring are Task 5; streaming scheduling is Task 6; character virtualization/WebP cache are Task 7; dynamic imports, measurement, recovery fallback, and focused integration gates are Tasks 8–9. The separate validation/release plan owns the final cross-plan and device release decision.
- No placeholders: every task contains exact files, RED code and command, implementation signature/code, GREEN command, and a commit.
- Type consistency: `DirtySnapshot`, `DirtyRegistry`, `buildSqlDirtyCommit`, `markSqlMessageDirty`, `ChatHydrationCache`, `getChatWindow`, `StreamRenderScheduler`, `getAssetUrl`, `BoundedLruCache`, and `SaverModeCoordinator` use the same names in all tasks.
