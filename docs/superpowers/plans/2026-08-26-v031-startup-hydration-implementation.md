# v0.3.1 Metadata-first Startup and Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal Node startup load bounded metadata first, hydrate character details and recent messages on demand, and retain an explicit safe degraded fallback without changing interchange formats or schema v3.

**Architecture:** Add read-only bounded queries to the server-side relational SQLite adapter and expose them through authenticated SQL routes. The Node browser client will construct a navigation-safe partial `Database`, hydrate only selected entities through new APIs, and preserve the legacy full snapshot route solely for explicit recovery. Startup timing is measured locally and expensive non-first-paint work is scheduled after interaction becomes available.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Express, Node `node:sqlite`, existing relational node codec and SQL commit layer.

---

## File structure

- Modify: `server/node/relational-sqlite.cjs` — bounded relational readers that reconstruct only requested node values.
- Modify: `server/node/server.cjs` — authenticated `/api/sql/bootstrap`, character, chat metadata, and reverse message-page routes.
- Modify: `server/node/relational-sqlite.test.ts` — relational reader contracts and cursor safety.
- Create: `src/ts/performance/startupMetrics.ts` — bounded, content-free browser performance marks and optional Long Task observer.
- Create: `src/ts/performance/startupMetrics.test.ts` — unavailable-browser-API and measure behavior tests.
- Modify: `src/ts/storage/sql/ISqlStorage.ts` — additive metadata/bootstrap and reverse-page contracts.
- Modify: `src/ts/storage/sql/nodeSqliteStorage.ts` — metadata API client and legacy snapshot recovery client.
- Modify: `src/ts/storage/sql/nodeSqliteStorage.test.ts` — no-normal-snapshot and endpoint-contract tests.
- Modify: `src/ts/storage/sql/sqlBootstrap.ts` — Node metadata bootstrap activation and explicit recovery result.
- Modify: `src/ts/storage/sql/sqlBootstrap.test.ts` — ready/empty/degraded bootstrap behavior.
- Create: `src/ts/storage/sql/sqlRuntimeHydration.ts` — deduplicated character and current-chat window hydration.
- Create: `src/ts/storage/sql/sqlRuntimeHydration.test.ts` — hydration dedupe, race, failure, and prepend tests.
- Modify: `src/ts/storage/chatStorage.ts` — delegate Node SQL placeholder hydration to bounded runtime hydration while retaining legacy server fallback.
- Modify: `src/ts/storage/sql/sqlCommit.ts` and `src/ts/storage/sql/sqlCommit.test.ts` — omit client-only hydration window fields from persistence.
- Modify: `src/ts/characters.ts` — hydrate a character before selecting it when it is metadata-only.
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte` — request the previous bounded message page instead of treating an initial page as a complete history.
- Modify: `src/ts/bootstrap.ts` — first-interactive mark, explicit degraded startup state, and after-first-paint scheduling.
- Create: `src/ts/bootstrapStartup.test.ts` — startup ordering and no-immediate-save connection tests.

## Task 1: Add content-free startup instrumentation

**Files:**

- Create: `src/ts/performance/startupMetrics.ts`
- Create: `src/ts/performance/startupMetrics.test.ts`

- [ ] **Step 1: Write the failing instrumentation tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { markPerformance, measurePerformance, observeLongTasks } from './startupMetrics'

describe('startup metrics', () => {
  it('does not throw when Performance APIs are unavailable', () => {
    const saved = globalThis.performance
    vi.stubGlobal('performance', undefined)
    expect(() => markPerformance('bootstrap-fetch:start')).not.toThrow()
    expect(measurePerformance('bootstrap-fetch', 'missing')).toBeNull()
    vi.stubGlobal('performance', saved)
  })

  it('observes only long-task duration and disconnects cleanly', () => {
    const disconnect = observeLongTasks(vi.fn())
    expect(typeof disconnect).toBe('function')
    disconnect()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ts/performance/startupMetrics.test.ts`

Expected: FAIL because `./startupMetrics` does not exist.

- [ ] **Step 3: Implement a bounded instrumentation utility**

```ts
export type StartupMetricMark =
  | 'bootstrap-fetch:start' | 'bootstrap-fetch:end'
  | 'bootstrap-json:end' | 'first-interactive'
  | 'character-hydration:start' | 'character-hydration:end'
  | 'message-page-fetch:start' | 'message-page-fetch:end'
  | 'sql-commit:start' | 'sql-commit:end'
  | 'render-batch:start' | 'render-batch:end'

export function markPerformance(name: StartupMetricMark): void {
  globalThis.performance?.mark?.(`risu:${name}`)
}

export function measurePerformance(name: string, start: StartupMetricMark, end?: StartupMetricMark): PerformanceMeasure | null {
  if (!globalThis.performance?.measure) return null
  try {
    return globalThis.performance.measure(`risu:${name}`, `risu:${start}`, end && `risu:${end}`)
  } catch { return null }
}

export function observeLongTasks(onDuration: (durationMs: number) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.duration > 100) onDuration(entry.duration)
    })
    observer.observe({ type: 'longtask', buffered: true })
    return () => observer.disconnect()
  } catch { return () => {} }
}
```

Do not attach character names, message text, IDs, asset paths, or request URLs to performance entries.

- [ ] **Step 4: Run the instrumentation tests to verify they pass**

Run: `pnpm vitest run src/ts/performance/startupMetrics.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated instrumentation slice**

```bash
git add src/ts/performance/startupMetrics.ts src/ts/performance/startupMetrics.test.ts
git commit -m "feat(perf): add bounded startup metrics"
```

## Task 2: Add bounded relational SQL read APIs

**Files:**

- Modify: `server/node/relational-sqlite.cjs:48-169`
- Modify: `server/node/relational-sqlite.test.ts`

- [ ] **Step 1: Write failing relational-reader tests**

Add fixtures through the existing `createRelationalSqlite` and commit layer. Cover these exact contracts:

```ts
it('returns bootstrap summaries without message extension rows', () => {
  const result = storage.bootstrap()
  expect(result.characters[0]).toMatchObject({ chaId: 'character-1', detailsLoaded: false })
  expect(result.characters[0].chats[0]).toMatchObject({ id: 'chat-1', message: [], messagesLoaded: false })
  expect(JSON.stringify(result)).not.toContain('message_extension_nodes')
})

it('returns newest messages as ascending reverse-cursor page', () => {
  expect(storage.loadChatMessages('chat-1', undefined, 2)).toMatchObject({
    messages: [{ chatId: 'message-2' }, { chatId: 'message-3' }],
    nextBefore: 1, total: 3, hasMore: true,
  })
})

it('clamps page limit to 100 and rejects invalid cursors', () => {
  expect(storage.loadChatMessages('chat-1', undefined, 999).messages).toHaveLength(3)
  expect(() => storage.loadChatMessages('chat-1', -1, 40)).toThrow(/before/i)
})
```

- [ ] **Step 2: Run the relational test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/relational-sqlite.test.ts`

Expected: FAIL because `bootstrap` and `loadChatMessages` are not methods on the relational adapter.

- [ ] **Step 3: Implement safe bounded readers in the relational adapter**

Inside `createRelationalSqlite`, add helpers after `dump()` and before `commit()`:

```js
const BOOTSTRAP_SETTING_KEYS = Object.freeze([
  'language', 'theme', 'textTheme', 'colorSchemeName', 'customColorScheme',
  'zoomsize', 'iconsize', 'heightMode', 'characterOrder', 'selectedPersona',
  'apiType', 'aiModel', 'subModel', 'temperature', 'maxContext', 'maxResponse',
  'frequencyPenalty', 'PresensePenalty', 'username', 'userIcon',
])
const DEFAULT_MESSAGE_PAGE_LIMIT = 40
const MAX_MESSAGE_PAGE_LIMIT = 100

function readNodeValue(table, whereSql, bind) {
  const rows = database.prepare(`SELECT * FROM ${table} WHERE ${whereSql} ORDER BY node_id`).all(...bind)
  return rows.length ? rebuildRelationalValue(rows) : undefined
}

function loadChatSummaryRows() {
  return database.prepare(`SELECT c.id, c.character_id, c.position, c.name, c.note, c.folder_id,
    c.last_message_time, COUNT(m.id) AS message_total
    FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
    GROUP BY c.id ORDER BY c.character_id, c.position`).all()
}

function bootstrap() {
  const placeholders = BOOTSTRAP_SETTING_KEYS.map(() => '?').join(',')
  const settingRows = database.prepare(`SELECT * FROM system_settings WHERE key IN (${placeholders})`).all(...BOOTSTRAP_SETTING_KEYS)
  const settings = Object.fromEntries(settingRows.map((row) => [row.key,
    readNodeValue('setting_extension_nodes', 'setting_key = ?', [row.key])]))
  const chatsByCharacter = new Map()
  for (const row of loadChatSummaryRows()) {
    const chat = { id: row.id, name: row.name, note: row.note, folderId: row.folder_id ?? undefined,
      lastDate: row.last_message_time ?? undefined, message: [], messageTotal: Number(row.message_total),
      messagesLoaded: false, messagesFullyLoaded: false, detailsLoaded: false }
    const chats = chatsByCharacter.get(row.character_id) ?? []
    chats.push(chat); chatsByCharacter.set(row.character_id, chats)
  }
  const characters = database.prepare('SELECT * FROM characters ORDER BY position').all().map((row) => ({
    chaId: row.id, type: row.kind, name: row.name, image: row.image ?? '', trashTime: row.trash_time ?? undefined,
    creationDate: row.creation_time ?? undefined, modificationDate: row.modification_time ?? undefined,
    lastInteraction: row.last_interaction_time ?? undefined, detailsLoaded: false, chats: chatsByCharacter.get(row.id) ?? [], chatPage: 0,
  }))
  return { status: Number(database.prepare('SELECT initialized FROM system_storage_meta WHERE singleton = 1').get()?.initialized) === 1 ? 'ready' : 'empty', revision: revision(), settings, pluginCustomStorage: {}, botPresets: [], characters, selectedCharacterId: null, selectedChatId: null }
}

function loadCharacter(characterId) {
  const row = database.prepare('SELECT id FROM characters WHERE id = ?').get(characterId)
  if (!row) return null
  const character = readNodeValue('character_extension_nodes', 'character_id = ?', [characterId]) ?? {}
  character.chaId = characterId; character.detailsLoaded = true
  character.chats = loadChatSummaryRows().filter((chat) => chat.character_id === characterId).map((chat) => ({ id: chat.id, name: chat.name, note: chat.note, folderId: chat.folder_id ?? undefined, lastDate: chat.last_message_time ?? undefined, message: [], messageTotal: Number(chat.message_total), messagesLoaded: false, messagesFullyLoaded: false, detailsLoaded: true }))
  return { revision: revision(), character }
}

function loadChatMessages(chatId, before, requestedLimit) {
  if (!database.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) return null
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('Invalid before cursor')
  const limit = Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_MESSAGE_PAGE_LIMIT))
  const total = Number(database.prepare('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?').get(chatId).total)
  const cursor = before ?? Number(database.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS cursor FROM messages WHERE chat_id = ?').get(chatId).cursor)
  const rows = database.prepare('SELECT id, position FROM messages WHERE chat_id = ? AND position < ? ORDER BY position DESC LIMIT ?').all(chatId, cursor, limit)
  const ids = rows.map((row) => row.id)
  const nodeRows = ids.length ? database.prepare(`SELECT * FROM message_extension_nodes WHERE chat_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_id, node_id`).all(chatId, ...ids) : []
  const byId = new Map(); for (const row of nodeRows) { const group = byId.get(row.message_id) ?? []; group.push(row); byId.set(row.message_id, group) }
  const messages = rows.reverse().map((row) => ({ ...(rebuildRelationalValue(byId.get(row.id) ?? []) ?? {}), chatId: row.id }))
  const nextBefore = rows.length ? Math.min(...rows.map((row) => Number(row.position))) : null
  return { revision: revision(), chatId, messages, before: before ?? null, nextBefore, total, hasMore: nextBefore !== null && nextBefore > 0 }
}
```

Use a read transaction (`BEGIN DEFERRED` / `COMMIT`) around each multi-query reader. Roll back on errors. Do not use `dump()` internally, and do not issue a query per message extension value: retrieve all page extension rows with `message_id IN (?, ...)`, group by `message_id`, then rebuild each message.

Return the following exact shapes:

```js
{ status: 'ready' | 'empty', revision, settings, pluginCustomStorage: {}, botPresets: [], characters, selectedCharacterId: null, selectedChatId: null }
{ revision, character: fullCharacter }
{ revision, chat: summaryChat }
{ revision, chatId, messages, before: normalizedBefore, nextBefore, total, hasMore }
```

Keep `dump()` unchanged for compatibility snapshot recovery. Export the new functions in the factory return value.

- [ ] **Step 4: Run relational-reader tests to verify they pass**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/relational-sqlite.test.ts`

Expected: PASS, including existing optimistic revision tests.

- [ ] **Step 5: Commit the bounded relational reader slice**

```bash
git add server/node/relational-sqlite.cjs server/node/relational-sqlite.test.ts
git commit -m "feat(sql): add bounded relational readers"
```

## Task 3: Expose authenticated bounded SQL routes

**Files:**

- Modify: `server/node/server.cjs:3609-3637`
- Create: `server/node/sql-bootstrap-routes.test.ts`

- [ ] **Step 1: Write failing route-connection tests**

Use a source-level route test only if `server.cjs` remains monolithic:

```ts
it('registers authenticated bounded SQL routes without replacing snapshot recovery', () => {
  const source = readFileSync('server/node/server.cjs', 'utf8')
  expect(source).toContain("app.get('/api/sql/bootstrap'")
  expect(source).toContain("app.get('/api/sql/characters/:characterId'")
  expect(source).toContain("app.get('/api/sql/chats/:chatId/messages'")
  expect(source).toContain("app.get('/api/sql/snapshot'")
  expect(source).toContain('relationalSql.loadChatMessages')
})
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/sql-bootstrap-routes.test.ts`

Expected: FAIL because bounded routes are absent.

- [ ] **Step 3: Register bounded routes immediately before the existing snapshot route**

Add handlers that preserve existing authentication semantics:

```js
app.get('/api/sql/bootstrap', async (req, res, next) => {
  if (!await checkAuth(req, res)) return
  try { res.set('Cache-Control', 'no-store').json(relationalSql.bootstrap()) } catch (error) { next(error) }
})

app.get('/api/sql/characters/:characterId', async (req, res, next) => {
  if (!await checkAuth(req, res)) return
  const id = String(req.params.characterId || '')
  if (!id || id.length > 256) return res.status(400).json({ error: 'Invalid character id' })
  try {
    const result = relationalSql.loadCharacter(id)
    if (!result) return res.status(404).json({ error: 'Character not found' })
    res.set('Cache-Control', 'no-store').json(result)
  } catch (error) { next(error) }
})

app.get('/api/sql/chats/:chatId/messages', async (req, res, next) => {
  if (!await checkAuth(req, res)) return
  const id = String(req.params.chatId || '')
  const before = req.query.before === undefined ? undefined : Number(req.query.before)
  const limit = req.query.limit === undefined ? 40 : Number(req.query.limit)
  if (!id || id.length > 256) return res.status(400).json({ error: 'Invalid chat id' })
  try {
    const result = relationalSql.loadChatMessages(id, before, limit)
    if (!result) return res.status(404).json({ error: 'Chat not found' })
    res.set('Cache-Control', 'no-store').json(result)
  } catch (error) { next(error) }
})
```

Do not require `checkActiveSession` for read routes. Do retain it for `/api/sql/commit`.

- [ ] **Step 4: Run route and relational tests to verify they pass**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/sql-bootstrap-routes.test.ts server/node/relational-sqlite.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the SQL route slice**

```bash
git add server/node/server.cjs server/node/sql-bootstrap-routes.test.ts
git commit -m "feat(server): expose bounded SQL read routes"
```

## Task 4: Add additive Node client contracts and metadata bootstrap

**Files:**

- Modify: `src/ts/storage/sql/ISqlStorage.ts:15-116`
- Modify: `src/ts/storage/sql/nodeSqliteStorage.ts:31-290`
- Modify: `src/ts/storage/sql/nodeSqliteStorage.test.ts`
- Modify: `src/ts/storage/sql/sqlBootstrap.ts:15-145`
- Modify: `src/ts/storage/sql/sqlBootstrap.test.ts`

- [ ] **Step 1: Write failing Node client and SQL bootstrap tests**

Extend `createClient()` so it records request paths and returns bounded mock payloads. Add:

```ts
it('opens an existing Node SQL database from bootstrap without requesting snapshot', async () => {
  const { client, requests } = createClientWithBootstrap()
  await client.init()
  const loaded = await client.loadDatabase({ shallow: true })
  expect(loaded?.database?.characters[0]).toMatchObject({ detailsLoaded: false, chats: [{ message: [] }] })
  expect(requests).toEqual(['/api/sql/bootstrap'])
})

it('keeps full snapshot behind an explicit recovery method', async () => {
  const { client, requests } = createClientWithBootstrap()
  await client.loadRecoverySnapshot()
  expect(requests).toContain('/api/sql/snapshot')
})

it('returns a degraded bootstrap result when Node bootstrap is unavailable', async () => {
  const storage = failingNodeStorage(503)
  const result = await openExistingStandaloneSql(storage)
  expect(result).toMatchObject({ usingSql: false, mode: 'degraded' })
})
```

- [ ] **Step 2: Run the client/bootstrap tests to verify they fail**

Run: `pnpm vitest run src/ts/storage/sql/nodeSqliteStorage.test.ts src/ts/storage/sql/sqlBootstrap.test.ts`

Expected: FAIL because the additive contracts and recovery method do not exist.

- [ ] **Step 3: Add additive storage types without changing existing offset APIs**

In `ISqlStorage.ts`, add:

```ts
export interface SqlBootstrapPayload { status: 'ready' | 'empty'; revision: number; settings: Record<string, unknown>; pluginCustomStorage: Record<string, unknown>; botPresets: StoredBotPreset[]; characters: character[]; selectedCharacterId: string | null; selectedChatId: string | null }
export interface SqlReverseMessagePage { revision: number; chatId: string; messages: Message[]; before: number | null; nextBefore: number | null; total: number; hasMore: boolean }
export interface SqlBootstrapStorage extends ISqlStorage {
  loadBootstrap(): Promise<SqlBootstrapPayload>
  loadRecoverySnapshot(): Promise<SqlLoadDatabaseResult | null>
  loadCharacterHydration(characterId: string): Promise<character | null>
  loadChatMessageReversePage(chatId: string, before: number | undefined, limit: number): Promise<SqlReverseMessagePage>
}
```

Implement these as public methods on `NodeSqliteStorage`; do not require `WebSqliteStorage` to adopt them. Consumers must narrow with `storage.backendKind === 'server-sql' && 'loadBootstrap' in storage`.

Implement the HTTP methods exactly as follows:

```ts
async loadCharacterHydration(characterId: string): Promise<character | null> {
  const response = await this.request(`/api/sql/characters/${encodeURIComponent(characterId)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`SQL character load failed (${response.status})`)
  const payload = await response.json() as { revision: number; character: character }
  this.revision = Number(payload.revision) || this.revision
  return payload.character
}

async loadChatMessageReversePage(chatId: string, before: number | undefined, limit: number): Promise<SqlReverseMessagePage> {
  const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Math.floor(limit)))) })
  if (before !== undefined) params.set('before', String(before))
  const response = await this.request(`/api/sql/chats/${encodeURIComponent(chatId)}/messages?${params}`)
  if (!response.ok) throw new Error(`SQL message page failed (${response.status})`)
  const page = await response.json() as SqlReverseMessagePage
  this.revision = Number(page.revision) || this.revision
  return page
}
```

- [ ] **Step 4: Replace normal Node initialization with `/api/sql/bootstrap`**

In `nodeSqliteStorage.ts`:

```ts
private bootstrapPayload: SqlBootstrapPayload | null = null

async loadBootstrap(): Promise<SqlBootstrapPayload> {
  markPerformance('bootstrap-fetch:start')
  const response = await this.request('/api/sql/bootstrap')
  markPerformance('bootstrap-fetch:end')
  if (!response.ok) throw new Error(`SQL bootstrap failed (${response.status})`)
  const payload = await response.json() as SqlBootstrapPayload
  markPerformance('bootstrap-json:end')
  this.revision = Number(payload.revision) || 0
  return payload
}

async init(): Promise<boolean> {
  if (this.enabled) return true
  this.bootstrapPayload = await this.loadBootstrap()
  this.enabled = true
  return true
}
```

Build the partial database from `settings`, `pluginCustomStorage`, preset data, and character/chat summaries. Each chat must have `message: []`, `messagesLoaded: false`, `messagesFullyLoaded: false`; each character must have `detailsLoaded: false`. Leave `fetchDump()` intact but call it only from `loadRecoverySnapshot()`.

Update `openExistingStandaloneSql()` to return:

```ts
type ExistingSqlOpenResult = SqlBootstrapResult & {
  mode: 'metadata-first' | 'degraded'
  recoveryStorage?: SqlBootstrapStorage
}
```

On a Node bootstrap error, return `{ database: {} as Database, storage: null, usingSql: false, migrated: false, mode: 'degraded', recoveryStorage: storage as SqlBootstrapStorage, error }`; do not silently call `/api/sql/snapshot`.

- [ ] **Step 5: Run client/bootstrap tests to verify they pass**

Run: `pnpm vitest run src/ts/storage/sql/nodeSqliteStorage.test.ts src/ts/storage/sql/sqlBootstrap.test.ts`

Expected: PASS and normal test request lists never include `/api/sql/snapshot`.

- [ ] **Step 6: Commit the metadata bootstrap slice**

```bash
git add src/ts/storage/sql/ISqlStorage.ts src/ts/storage/sql/nodeSqliteStorage.ts src/ts/storage/sql/nodeSqliteStorage.test.ts src/ts/storage/sql/sqlBootstrap.ts src/ts/storage/sql/sqlBootstrap.test.ts
git commit -m "feat(sql): bootstrap Node clients from metadata"
```

## Task 5: Hydrate selected characters and bounded reverse message windows

**Files:**

- Create: `src/ts/storage/sql/sqlRuntimeHydration.ts`
- Create: `src/ts/storage/sql/sqlRuntimeHydration.test.ts`
- Modify: `src/ts/storage/chatStorage.ts:133-208`
- Modify: `src/ts/storage/sql/sqlCommit.ts:115-135`
- Modify: `src/ts/storage/sql/sqlCommit.test.ts`
- Modify: `src/ts/characters.ts:770-821`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`

- [ ] **Step 1: Write failing hydration unit tests**

```ts
it('deduplicates concurrent character hydration and replaces only the matching summary', async () => {
  const loadCharacterHydration = vi.fn(async () => fullCharacter)
  const [first, second] = await Promise.all([
    ensureCharacterHydrated(db, 0, loadCharacterHydration),
    ensureCharacterHydrated(db, 0, loadCharacterHydration),
  ])
  expect(loadCharacterHydration).toHaveBeenCalledOnce()
  expect(first?.detailsLoaded).toBe(true)
  expect(second?.chaId).toBe('character-1')
})

it('loads newest 40, then prepends an older reverse page without duplicates', async () => {
  await ensureChatMessageWindow(character, 0, { limit: 40 })
  await loadOlderChatMessages(character, 0, 40)
  expect(character.chats[0].message.map((m) => m.chatId)).toEqual(['m0', 'm1', 'm2'])
  expect((character.chats[0] as any)._sqlWindow.hasOlder).toBe(false)
})

it('does not replace a summary if the user selected another character before hydration resolves', async () => {
  const pending = deferred<character>()
  const result = ensureCharacterHydrated(db, 0, () => pending.promise)
  db.characters[0] = anotherCharacter
  pending.resolve(fullCharacter)
  await result
  expect(db.characters[0]).toBe(anotherCharacter)
})
```

- [ ] **Step 2: Run hydration tests to verify they fail**

Run: `pnpm vitest run src/ts/storage/sql/sqlRuntimeHydration.test.ts src/ts/storage/sql/sqlCommit.test.ts`

Expected: FAIL because runtime hydration helpers and `_sqlWindow` stripping do not exist.

- [ ] **Step 3: Implement runtime hydration with transient state**

Create `sqlRuntimeHydration.ts` with exact public functions:

```ts
export type SqlHydrationWindow = { before: number | null; nextBefore: number | null; total: number; hasOlder: boolean }
export async function ensureCharacterHydrated(db: Database, characterIndex: number): Promise<character | null>
export async function ensureChatMessageWindow(character: character, chatIndex: number, limit?: number): Promise<Chat | null>
export async function loadOlderChatMessages(character: character, chatIndex: number, limit?: number): Promise<Chat | null>
```

Use `getActiveSqlStorage()` and narrow to `NodeSqliteStorage` methods. Keep a `Map<string, Promise<character | null>>` and `Map<string, Promise<Chat | null>>` for dedupe. Before assigning a hydrated result, find the character/chat again by stable ID; never rely on the original array index after an `await`.

For a tail page, call `loadChatMessageReversePage(chat.id, undefined, 40)`. Store an ascending `chat.message`; attach non-enumerable-or-explicit transient `_sqlWindow` containing cursor/total/hasOlder. For an older page, use the existing `nextBefore`, prepend only message IDs not already in the loaded window, and update the cursor.

Add `_sqlWindow` to the transient field deletion in `sqlCommit.ts` next to `messagesLoaded`, `messageOffset`, and `messageTotal`:

```ts
delete data._sqlWindow
```

- [ ] **Step 4: Route existing placeholder hydration through SQL only for Node SQL**

At the beginning of `ensureChatHydrated()` in `chatStorage.ts`, use the active SQL store when it is `server-sql`; otherwise preserve the current `fetchChatFromServer()` full-chat behavior. The Node SQL branch must request the initial bounded window and preserve the existing `hydrationInFlight` / `hydrationJustApplied` dirty-write suppression.

- [ ] **Step 5: Hydrate character details before selection**

In `characters.ts` `changeChar()`, before `characterFormatUpdate()` and `selectedCharID.set(index)`, add a summary guard:

```ts
if (db.characters[index] && db.characters[index].detailsLoaded === false) {
  loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: null })
  const hydrated = await ensureCharacterHydrated(db, index)
  loadingOverlayStore.set({ active: false, text: '', onCancel: null })
  if (!hydrated) return
}
```

Change `changeChar` to `async` and update every call site that needs post-selection ordering to `await changeChar(...)`; fire-and-forget UI click handlers may use `void changeChar(...)`. Do not call `characterFormatUpdate()` on metadata-only characters because it can write defaults into incomplete data.

- [ ] **Step 6: Connect Previous messages UI to bounded older-page loading**

In `DefaultChatScreen.svelte`, when the user invokes previous-message navigation at the oldest loaded local page and `_sqlWindow.hasOlder` is true, await `loadOlderChatMessages(currentCharacter, currentCharacter.chatPage, 40)`, then set the local pagination page to the new page containing the former first rendered message. Do not present an unloaded absolute history page as if all `messageTotal` messages are resident.

Before generation or any request that requires complete chat history, add a clear safe guard in the request entry path: either hydrate all pages with progress or show an explicit "Load earlier messages before generating" action. Do not allow prompt construction from an implicit truncated 40-message array.

- [ ] **Step 7: Run hydration and focused UI tests to verify they pass**

Run: `pnpm vitest run src/ts/storage/sql/sqlRuntimeHydration.test.ts src/ts/storage/chatStorage.test.ts src/ts/storage/sql/sqlCommit.test.ts src/lib/ChatScreens/ChatPaginationConnections.test.ts`

Expected: PASS. The persistence commit test must prove `_sqlWindow` is never serialized.

- [ ] **Step 8: Commit the hydration slice**

```bash
git add src/ts/storage/sql/sqlRuntimeHydration.ts src/ts/storage/sql/sqlRuntimeHydration.test.ts src/ts/storage/chatStorage.ts src/ts/storage/sql/sqlCommit.ts src/ts/storage/sql/sqlCommit.test.ts src/ts/characters.ts src/lib/ChatScreens/DefaultChatScreen.svelte
git commit -m "feat(chat): hydrate Node SQL data on demand"
```

## Task 6: Make degraded recovery explicit and defer non-first-paint startup work

**Files:**

- Modify: `src/ts/bootstrap.ts:57-205,283-477`
- Create: `src/ts/bootstrapStartup.test.ts`

- [ ] **Step 1: Write failing startup ordering and degraded-mode tests**

Use module mocks and source-connection assertions that do not execute application startup DOM work:

```ts
it('marks first interactive before plugin/update/cleanup work is scheduled', () => {
  const source = readFileSync('src/ts/bootstrap.ts', 'utf8')
  expect(source.indexOf("loadedStore.set(true)")).toBeLessThan(source.indexOf('scheduleAfterFirstPaint(() => loadPlugins()'))
  expect(source).toContain("markPerformance('first-interactive')")
})

it('does not call saveDb immediately after metadata-first Node bootstrap', () => {
  const source = readFileSync('src/ts/bootstrap.ts', 'utf8')
  expect(source).toContain("if (startupMode !== 'metadata-first') saveDb()")
})

it('labels snapshot recovery as degraded instead of silently performing it', () => {
  const source = readFileSync('src/ts/bootstrap.ts', 'utf8')
  expect(source).toContain('degraded')
  expect(source).toContain('loadRecoverySnapshot')
})
```

- [ ] **Step 2: Run the startup test to verify it fails**

Run: `pnpm vitest run src/ts/bootstrapStartup.test.ts`

Expected: FAIL because no after-first-paint scheduler or explicit degraded mode exists.

- [ ] **Step 3: Add an after-first-paint scheduler**

Add near the top of `bootstrap.ts`:

```ts
export function scheduleAfterFirstPaint(task: () => void | Promise<void>, timeoutMs = 2_000): void {
  const run = () => { void Promise.resolve(task()).catch(console.error) }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: timeoutMs })
    } else {
      window.setTimeout(run, 0)
    }
  }))
}
```

Use a local TypeScript declaration or `Window & { requestIdleCallback?: ... }` guard if the configured DOM library does not include `requestIdleCallback`.

- [ ] **Step 4: Split metadata-safe boot from character mutation work**

Keep root UI normalization and `setDatabase()` before first paint. Extract the character-only mutation portion of `checkNewFormat()` into:

```ts
export function normalizeHydratedCharacter(character: character): character
```

Call it only after `ensureCharacterHydrated` returns a full character. Do not run `characterFormatUpdate`, `purgeUnsupportedGroupChats`, image path normalization, or chat-wide streaming-flag cleanup against `detailsLoaded === false` summaries.

- [ ] **Step 5: Implement explicit degraded recovery**

In `loadData()`:

```ts
const existingSql = await openExistingStandaloneSql()
const startupMode = existingSql?.mode
if (existingSql?.usingSql) {
  setDatabase(existingSql.database)
} else if (startupMode === 'degraded') {
  LoadingStatusState.text = 'Server metadata load failed. Recovering in degraded mode...'
  const recovery = await existingSql?.recoveryStorage?.loadRecoverySnapshot()
  if (!recovery?.database) throw existingSql?.error ?? new Error('SQL recovery snapshot unavailable')
  setDatabase(recovery.database)
  alertError('Started in degraded compatibility mode. Update the server to restore fast startup.')
} else {
  // Existing legacy database.bin load/migration branch.
}
```

Only this explicit branch may call `/api/sql/snapshot`. A 404 bootstrap response must show server-update guidance instead of attempting browser-local heavy import. Keep existing backup loop for genuine local legacy decode failures.

- [ ] **Step 6: Defer expensive work after `loadedStore.set(true)`**

Retain first-paint UI setup before interactive state: color scheme, text theme, animation speed, height mode, GUI size, mobile gesture setup, and `startObserveDom()`.

Immediately after `loadedStore.set(true)`, add `markPerformance('first-interactive')`, then schedule:

```ts
scheduleAfterFirstPaint(() => loadPlugins())
scheduleAfterFirstPaint(() => registerModelDynamic())
scheduleAfterFirstPaint(() => moduleUpdate())
scheduleAfterFirstPaint(() => cleanChunks(), 5_000)
scheduleAfterFirstPaint(() => checkRisuUpdate())
scheduleAfterFirstPaint(() => initModelJobRecovery())
```

Do not invoke `saveDb()` immediately when `startupMode === 'metadata-first'`; that could serialize incomplete summaries. Keep it for legacy/full modes. Make module-dependent controls disabled until `loadPlugins()` resolves; plugin APIs must not be given metadata-only character data.

- [ ] **Step 7: Run startup tests to verify they pass**

Run: `pnpm vitest run src/ts/bootstrapStartup.test.ts src/ts/bootstrapErrorHandling.test.ts src/ts/storage/sql/sqlBootstrap.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the startup/recovery slice**

```bash
git add src/ts/bootstrap.ts src/ts/bootstrapStartup.test.ts
git commit -m "perf(startup): defer noncritical Node initialization"
```

## Task 7: Verify the complete startup/hydration slice

**Files:**

- Modify only if failures reveal a defect in the files listed in Tasks 1-6.

- [ ] **Step 1: Run all focused contracts**

Run:

```bash
pnpm vitest run src/ts/performance/startupMetrics.test.ts src/ts/storage/sql/nodeSqliteStorage.test.ts src/ts/storage/sql/sqlBootstrap.test.ts src/ts/storage/sql/sqlRuntimeHydration.test.ts src/ts/storage/chatStorage.test.ts src/ts/storage/sql/sqlCommit.test.ts src/ts/bootstrapStartup.test.ts src/lib/ChatScreens/ChatPaginationConnections.test.ts
pnpm vitest run --config vitest.config.server.ts server/node/relational-sqlite.test.ts server/node/sql-bootstrap-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static checks and production build**

Run:

```bash
pnpm check
pnpm build
```

Expected: `pnpm check` exits 0. `pnpm build` exits 0; record any pre-existing chunk/CSS warnings separately from new failures.

- [ ] **Step 3: Execute manual bounded-data smoke checks**

1. Seed a Node SQLite database with 200 characters and a chat containing at least 120 messages through existing SQL commit fixtures.
2. Load the app through Node mode and inspect the Network panel: first boot calls `/api/sql/bootstrap` and does not call `/api/sql/snapshot`.
3. Confirm only 40 recent messages are present after opening the seeded chat.
4. Use Previous once; confirm exactly the preceding 40 messages are prepended, no duplicate IDs exist, and the current scroll anchor remains visible.
5. Select a different summary character while the first hydration request is delayed; confirm stale response does not overwrite the new selection.
6. Force `/api/sql/bootstrap` to return 503; confirm the UI identifies degraded compatibility mode before snapshot recovery.
7. Refresh after metadata-first startup and inspect revision/commit logs; confirm no write occurred solely because summaries were installed.

- [ ] **Step 4: Commit only any verification-driven corrections**

```bash
git add server/node/relational-sqlite.cjs server/node/server.cjs src/ts/storage/sql/nodeSqliteStorage.ts src/ts/storage/sql/sqlBootstrap.ts src/ts/storage/sql/sqlRuntimeHydration.ts src/ts/storage/chatStorage.ts src/ts/characters.ts src/lib/ChatScreens/DefaultChatScreen.svelte src/ts/bootstrap.ts
git commit -m "fix(startup): address hydration verification findings"
```

Do not make this commit when verification required no source changes.

## Compatibility and release constraints

- Preserve `/api/sql/snapshot`, `/api/chat-content`, and `database.bin` flows for old clients and explicit recovery; new normal Node startup must not call them.
- Do not change SQLite schema version or `.charx`, `.risum`, or backup formats in this slice.
- Do not run full graph `checkNewFormat()` or `saveDb()` on a metadata-only database.
- Preserve the existing compatibility behavior where `Message.chatId` contains the message ID after relational reconstruction.
- Do not let prompt generation silently use an initial 40-message window as a complete history.
- Any revision conflict recovery added in later Dirty Registry work must use these targeted read APIs; it must not reintroduce automatic full snapshot reloads.

## Self-review checklist

- [x] Approved design coverage: instrumentation, metadata bootstrap, character hydration, reverse message paging, explicit fallback, and deferred work are all covered.
- [x] No schema migration, external file-format change, thumbnail work, Dirty Registry implementation, or `.risum` transport work is included.
- [x] Every code-changing task has RED command, concrete implementation content, GREEN command, and a commit boundary.
- [x] `SqlReverseMessagePage`, `ensureCharacterHydrated`, `ensureChatMessageWindow`, and `loadOlderChatMessages` names are consistent across tasks.
- [x] The normal startup path never calls snapshot; snapshot is only specified for explicit degraded recovery.
