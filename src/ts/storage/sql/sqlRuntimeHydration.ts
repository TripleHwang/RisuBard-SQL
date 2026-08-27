import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage, SqlCharacterRepairResult } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";
import { chatHydrationKey } from "../chatHydrationKey";
import { validateOlderMessagePage } from "../../chatWindow";
import { getSqlPosition, getSqlWindow, setSqlPosition, setSqlWindow, type SqlHydrationWindow } from "./sqlRuntimeMeta";
import { language } from "src/lang";

export type { SqlHydrationWindow };

/**
 * Turns a failed repair into a message that claims no more than the server
 * actually examined.
 *
 * The rule this enforces: only `absent-from-all` — the case where every backup
 * that exists was decoded and searched — may tell the user the character is
 * not in any backup. `absent-from-examined` names how many were checked AND
 * how many were not, so an unchecked backup still reads as a live lead rather
 * than a verdict. `all-unreadable` says nothing about presence at all, because
 * nothing was ever looked at.
 *
 * A reason that needs counts but arrives without a usable census degrades to
 * the unknown-reason message rather than quoting a number nobody measured.
 */
export function repairUnavailableMessage(result: SqlCharacterRepairResult): string {
  const census = result.backups;
  if (result.reason === "no-backups") return language.sqlCharacterRepairUnavailableNoBackups;
  if (census) {
    if (result.reason === "all-unreadable") {
      return language.sqlCharacterRepairUnavailableAllUnreadable.replace("{}", String(census.total));
    }
    if (result.reason === "absent-from-all") {
      return language.sqlCharacterRepairUnavailableAbsentFromAll.replace("{}", String(census.total));
    }
    if (result.reason === "absent-from-examined") {
      // Everything not searched — unreadable plus never-opened — is one number
      // to the user: backups that might still hold the character.
      const unchecked = census.unreadable + census.skipped;
      return language.sqlCharacterRepairUnavailableAbsentFromExamined
        .replace("{}", String(census.examined))
        .replace("{}", String(unchecked));
    }
  }
  return language.sqlCharacterRepairUnavailableUnknown;
}

type HydratableCharacter = character & { detailsLoaded?: boolean };
type CollapsedCharacter = character & { _sqlCharacterBodyCollapsed?: boolean };
type HydratableChat = Chat & { messagesLoaded?: boolean; messagesFullyLoaded?: boolean };

/**
 * Metadata bootstrap deliberately does not mutate partial character summaries.
 * This normalizer is called only after the complete record response arrives;
 * selection subsequently applies the broader legacy character migration.
 */
export function normalizeHydratedCharacter(value: character): character {
  value.chats ??= [];
  value.chatPage ??= 0;
  value.customscript ??= [];
  value.globalLore ??= [];
  value.emotionImages ??= [];
  (value as HydratableCharacter).detailsLoaded = true;
  return value;
}

const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_CHAT_HYDRATION_ATTEMPTS = 2;
const characterHydrations = new Map<string, Promise<character | null>>();
const chatHydrations = new Map<string, Promise<Chat | null>>();
/**
 * Older-page loads are tracked separately from initial window hydration even
 * though both are keyed by the same chat. Sharing one map let a `loadOlder`
 * that arrived during initial hydration be handed the hydration's promise:
 * it fetched nothing, resolved truthy, and left the message count unchanged —
 * which the viewport autofill reads as a stalled load and reports as a failed
 * page with a Retry button that had nothing to retry.
 */
const chatOlderHydrations = new Map<string, Promise<Chat | null>>();
const chatBodyHydrations = new Map<string, Promise<Chat | null>>();

/**
 * Publishes the in-flight entry BEFORE its body can run, and retires it only
 * if it is still the entry we published.
 *
 * A body that fails synchronously — a storage backend that throws before its
 * first `await` — otherwise runs its own cleanup during the same synchronous
 * turn that creates the promise, i.e. before `set` ever happened. The `delete`
 * no-ops, `set` then caches an already-rejected promise, and every later
 * attempt is served that same stale rejection forever, so the operation can
 * never recover even once the backend is healthy again.
 *
 * Cleanup therefore lives here, on a `.finally` whose callback is guaranteed
 * to run as a microtask — never synchronously, not even for an already
 * rejected promise — so `set` always precedes `delete`. The body still starts
 * synchronously, so callers that depend on a request being issued before the
 * next microtask are unaffected.
 */
function trackInFlight<T>(pending: Map<string, Promise<T>>, key: string, body: () => Promise<T>): Promise<T> {
  let running: Promise<T>;
  try { running = body(); } catch (error) { running = Promise.reject(error); }
  const started: Promise<T> = running.finally(() => {
    if (pending.get(key) === started) pending.delete(key);
  });
  pending.set(key, started);
  return started;
}
type RevisionedChat = Chat & {
  _sqlHydrationRevision?: number;
  _sqlMetadataOverrides?: Record<string, unknown>;
};
const CHAT_METADATA_KEYS = ["name", "note", "folderId", "lastDate"] as const;
function metadataSnapshot(chat: Chat): Record<string, unknown> {
  return Object.fromEntries(CHAT_METADATA_KEYS.flatMap((key) => Object.prototype.hasOwnProperty.call(chat, key) ? [[key, (chat as unknown as Record<string, unknown>)[key]]] : []));
}
function metadataChanges(chat: Chat, baseline: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CHAT_METADATA_KEYS.flatMap((key) => Object.prototype.hasOwnProperty.call(chat, key) && !Object.is((chat as unknown as Record<string, unknown>)[key], baseline[key]) ? [[key, (chat as unknown as Record<string, unknown>)[key]]] : []));
}

function getNodeBootstrapStorage(): SqlBootstrapStorage | null {
  const storage = getActiveSqlStorage();
  if (storage?.backendKind !== "server-sql" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadCharacterHydration !== "function" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadChatMessageReversePage !== "function") {
    return null;
  }
  return storage as SqlBootstrapStorage;
}

function normalizeLimit(limit?: number): number {
  return Math.min(100, Math.max(1, Math.floor(limit ?? DEFAULT_MESSAGE_LIMIT)));
}

function setWindow(chat: Chat, window: SqlHydrationWindow): void {
  setSqlWindow(chat, window);
}

function getWindow(chat: Chat): SqlHydrationWindow | undefined {
  return getSqlWindow(chat);
}

function attachCanonicalPositions(messages: Chat["message"], positions: number[] | undefined): void {
  if (!positions || positions.length !== messages.length) return;
  for (const [index, message] of messages.entries()) {
    setSqlPosition(message, positions[index]);
  }
}

/**
 * Reverse pages are a different contract from forward hydration: every page
 * must terminate exactly at the persisted boundary we asked for. Validate the
 * response before attaching positions or replacing either observable window.
 *
 * `total` and `nextPosition` are deliberately NOT compared against the stored
 * window. Server-side they are live chat-wide counters — `COUNT(*)` and
 * `COALESCE(MAX(position) + 1, 0)` over the whole chat, recomputed on every
 * page read — so they legitimately move the instant the chat grows or shrinks.
 * The window, by contrast, is captured once when the newest page is attached
 * and never re-established for the session. Comparing them turned "the user
 * sent one more message" into a permanent, retry-proof rejection of every
 * older page: identical inputs, identical failure, forever.
 *
 * The real contiguity invariant is the cursor echo. The server replies with
 * the exact `before` it was asked for, so `page.before === window.nextBefore`
 * still pins this page to the boundary the window ends at. Everything below —
 * position ordering, upper bound, duplicate IDs, the terminal boundary and the
 * terminal coverage cross-check — is unchanged; this is a data-integrity
 * boundary and only the two live counters were removed from it.
 *
 * `knownPersistedCount` is the number of already-loaded messages that carry a
 * canonical SQL position, which is exactly the set the server's `total`
 * counts. It is not `knownIds.size`: a locally appended message that has not
 * been through a dirty commit has no position and no row, so counting it would
 * let the terminal-coverage equality hold while older persisted messages were
 * still unfetched — concluding "we have everything" early and silently hiding
 * real history.
 */
function validateOlderReversePage(
  page: Awaited<ReturnType<SqlBootstrapStorage["loadChatMessageReversePage"]>>,
  window: SqlHydrationWindow,
  knownIds: Set<string | undefined>,
  knownPersistedCount: number,
): void {
  if (page.before !== window.nextBefore) {
    throw new Error("Reverse page metadata changed")
  }
  if (!Array.isArray(page.positions) || page.positions.length !== page.messages.length) {
    throw new Error("Reverse page positions are invalid")
  }
  const seen = new Set<string>()
  let previous = -Infinity
  for (const [index, message] of page.messages.entries()) {
    const id = message.chatId
    const position = page.positions[index]
    if (!id || knownIds.has(id) || seen.has(id)) throw new Error("Reverse page has duplicate message IDs")
    if (!Number.isSafeInteger(position) || position <= previous || position >= (window.nextBefore ?? Infinity)) {
      throw new Error("Reverse page positions are noncontiguous")
    }
    seen.add(id)
    previous = position
  }
  if (page.hasMore ? page.nextBefore !== page.positions[0] : page.nextBefore !== null) {
    throw new Error("Reverse page boundary is noncontiguous")
  }
  if (!page.hasMore && knownPersistedCount + seen.size !== page.total) {
    throw new Error("Reverse page terminal coverage is incomplete")
  }
}

/** Messages the server's `COUNT(*)` can already see: those with a canonical position. */
function countPersistedMessages(messages: Chat["message"]): number {
  return messages.reduce((count, message) => count + (Number.isSafeInteger(getSqlPosition(message)) ? 1 : 0), 0);
}

export async function ensureCharacterHydrated(db: Database, characterIndex: number): Promise<character | null> {
  const summary = db.characters[characterIndex];
  if (!summary) return null;
  if ((summary as HydratableCharacter).detailsLoaded !== false) return summary;
  const storage = getNodeBootstrapStorage();
  if (!storage) return summary;

  const characterId = summary.chaId;
  const existing = characterHydrations.get(characterId);
  if (existing) return existing;

  return trackInFlight(characterHydrations, characterId, async () => {
    const full = await storage.loadCharacterHydration(characterId);
    if (!full) return null;
    if ((full as CollapsedCharacter)._sqlCharacterBodyCollapsed) {
      if (typeof (storage as Partial<SqlBootstrapStorage>).repairCollapsedCharacter !== "function") throw new Error("SQL character repair is unavailable");
      const repaired = await storage.repairCollapsedCharacter(characterId);
      // `unavailable` means the server finished walking the candidates it
      // was able to open without finding an applicable match — never re-read
      // here, since the row on disk is guaranteed unchanged (the server only
      // ever commits on a match). The reason code plus the backup census
      // decide how much the message is allowed to claim.
      if (repaired.status === "unavailable") throw new Error(repairUnavailableMessage(repaired));
      const reloaded = await storage.loadCharacterHydration(characterId);
      if (!reloaded || (reloaded as CollapsedCharacter)._sqlCharacterBodyCollapsed) throw new Error("SQL character repair did not restore the character body");
      return applyHydratedCharacter(db, characterId, reloaded);
    }
    return applyHydratedCharacter(db, characterId, full);
  });
}

function applyHydratedCharacter(db: Database, characterId: string, full: character): character | null {
      const currentIndex = db.characters.findIndex((value) => value?.chaId === characterId);
      if (currentIndex === -1 || (db.characters[currentIndex] as HydratableCharacter | undefined)?.detailsLoaded !== false) return null;
      const normalized = normalizeHydratedCharacter(full);
      db.characters[currentIndex] = normalized;
      return normalized;
}

async function ensureChatBodyHydrated(
  character: character,
  chatIndex: number,
  carriedMetadata: Record<string, unknown> = {},
): Promise<Chat | null> {
  const summary = character.chats[chatIndex];
  if (!summary) return null;
  if ((summary as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded !== false) return summary;
  const storage = getNodeBootstrapStorage();
  if (!storage || typeof (storage as Partial<SqlBootstrapStorage>).loadChatHydration !== "function") return summary;
  const chatId = summary.id;
  if (!chatId) return null;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatBodyHydrations.get(key);
  if (existing) return existing;
  const initialMetadata = metadataSnapshot(summary);

  return trackInFlight(chatBodyHydrations, key, async () => {
      const response = await storage.loadChatHydration(chatId);
      if (!response) return null;
      const full = response.chat;
      if ((full as Chat & { characterId?: unknown }).characterId !== character.chaId) throw new Error("SQL chat hydration owner mismatch");
      const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current || (current as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded !== false) return null;
      const summaryMetadata = Object.fromEntries(
        CHAT_METADATA_KEYS.flatMap((key) =>
          Object.prototype.hasOwnProperty.call(carriedMetadata, key)
            ? [[key, carriedMetadata[key]]]
            : Object.prototype.hasOwnProperty.call(current, key) && !Object.is((current as unknown as Record<string, unknown>)[key], initialMetadata[key])
            ? [[key, (current as unknown as Record<string, unknown>)[key]]]
            : [],
        ),
      );
      // SAFE: `merged` is a brand-new plain object literal produced by object
      // spread. Object spread always constructs a fresh ordinary object via
      // CreateDataPropertyOrThrow — it can never itself be (or become) a
      // Svelte `$state` proxy, regardless of whether `full`/`current` are
      // proxies. `defineProperty` below therefore always runs against a
      // plain target and never hits Svelte's proxy `defineProperty` trap
      // (`state_descriptors_fixed`). `merged` only enters the reactive tree
      // afterwards, via the plain assignment `character.chats[currentIndex]
      // = merged` a few lines down — and Svelte's proxy preserves a
      // non-enumerable descriptor that was already present on the target
      // object it wraps (see `getOwnPropertyDescriptor` in
      // node_modules/svelte's client proxy), so these fields stay hidden
      // from `Object.keys`/`JSON.stringify`/`for...in` even once `merged`
      // becomes reactive.
      const merged = { ...full, ...summaryMetadata, message: current.message ?? full.message ?? [] } as Chat;
      Object.defineProperty(merged, "_sqlHydrationRevision", { configurable: true, enumerable: false, value: response.revision });
      Object.defineProperty(merged, "_sqlMetadataOverrides", { configurable: true, enumerable: false, value: { ...carriedMetadata, ...summaryMetadata } });
      (merged as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded = true;
      character.chats[currentIndex] = merged;
      return merged;
  });
}

/** Hydrate a chat body before attaching its newest bounded message page. */
export async function ensureChatHydrated(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  return await ensureChatMessageWindow(character, chatIndex, limit);
}

export async function ensureChatMessageWindow(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  let initial = await ensureChatBodyHydrated(character, chatIndex);
  if (!initial) return null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return initial;
  const chatId = initial.id;
  if (!chatId) return null;
  const existingWindow = getWindow(initial);
  if (existingWindow) return initial;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  return trackInFlight(chatHydrations, key, async () => {
    // `beginHydration` is inside the guarded region so no path can reach the
    // body without its `endHydration` being scheduled. The flag keeps the pair
    // balanced: `endHydration` must not decrement a counter this call never
    // incremented, because that would retire a *concurrent* hydration's entry
    // and unblock LRU eviction (`hasLiveChatWork`) while work is still live.
    let counted = false;
    try {
      beginHydration(key);
      counted = true;
      let page;
      for (let attempt = 0; attempt < MAX_CHAT_HYDRATION_ATTEMPTS; attempt += 1) {
        const pageMetadata = metadataSnapshot(initial);
        page = await storage.loadChatMessageReversePage(chatId, undefined, normalizeLimit(limit));
        if (page.revision === (initial as RevisionedChat)._sqlHydrationRevision) break;
        if (attempt + 1 === MAX_CHAT_HYDRATION_ATTEMPTS) throw new Error("SQL chat hydration revision changed");
        const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
        const current = currentIndex === -1 ? null : character.chats[currentIndex];
        if (!current) return null;
        (current as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded = false;
        initial = await ensureChatBodyHydrated(character, currentIndex, { ...(current as RevisionedChat)._sqlMetadataOverrides, ...metadataChanges(current, pageMetadata) });
        if (!initial) return null;
      }
      if (!page) return null;
      const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;
      attachCanonicalPositions(page.messages, page.positions);
      current.message = page.messages;
      current._placeholder = false;
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        nextPosition: page.nextPosition,
      });
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      if (counted) endHydration(key);
    }
  });
}

export async function loadOlderChatMessages(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const pendingChat = character.chats[chatIndex];
  if (!pendingChat) return null;
  // An initial window hydration *replaces* `chat.message` and installs the
  // window this call needs to read. Chain onto it rather than impersonating
  // it: while the two shared one in-flight entry, a `loadOlder` arriving mid
  // hydration was handed the hydration's promise, fetched nothing, and
  // resolved truthy with the message count unchanged — which the viewport
  // autofill's no-progress detector reports as a failed page, showing a Retry
  // button for a request that was never made.
  const pendingInitial = pendingChat.id ? chatHydrations.get(chatHydrationKey(character.chaId, pendingChat.id)) : undefined;
  if (pendingInitial) await pendingInitial.catch(() => null);

  const chat = character.chats[chatIndex];
  const window = chat && getWindow(chat);
  if (!chat || !window || !window.hasOlder || window.nextBefore === null) return chat ?? null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return chat;
  const chatId = chat.id;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatOlderHydrations.get(key);
  if (existing) return existing;

  return trackInFlight(chatOlderHydrations, key, async () => {
    // See `ensureChatMessageWindow` for why the begin/end pair is guarded.
    let counted = false;
    try {
      beginHydration(key);
      counted = true;
      const page = await storage.loadChatMessageReversePage(chatId, window.nextBefore ?? undefined, normalizeLimit(limit));
      const currentIndex = character.chats.findIndex((value) => value?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;
      const known = new Set(current.message.map((message) => message.chatId));
      const knownPersistedCount = countPersistedMessages(current.message);
      try {
        // Use the common ID/total guard at the merge boundary; persisted SQL
        // boundaries and positions are validated below by this backend contract.
        // Both sides read `page.total` so the shared guard checks IDs only —
        // the window's captured copy is stale by construction (see
        // `validateOlderReversePage`), and the live counter cannot disagree
        // with itself.
        validateOlderMessagePage(
          { offset: 0, total: page.total, messages: page.messages },
          { offset: page.messages.length, total: page.total, ids: [...known].filter((id): id is string => !!id) },
        );
        validateOlderReversePage(page, window, known, knownPersistedCount);
      } catch (error) {
        // A rejected page leaves a Retry button whose cause is otherwise
        // invisible. Log the counters that decide it — never message content.
        console.error("[chat-history] rejected an older reverse page", {
          chatId,
          window: { before: window.before, nextBefore: window.nextBefore, total: window.total, nextPosition: window.nextPosition },
          page: { before: page.before, nextBefore: page.nextBefore, total: page.total, nextPosition: page.nextPosition, hasMore: page.hasMore, count: page.messages.length },
          loaded: { messages: current.message.length, persisted: knownPersistedCount },
        }, error);
        throw error;
      }
      // Both validators reject a page carrying any already-loaded ID, so every
      // message in it is new. (The former "the server returned only messages we
      // already have, so stop paginating" branch lived here and was
      // unreachable behind those checks; it is gone rather than reachable —
      // reaching it would have meant weakening duplicate detection, and its
      // "recovery" silently declared the history complete, hiding real
      // messages. A distinguishable error is the honest outcome.)
      attachCanonicalPositions(page.messages, page.positions);
      current.message = [...page.messages, ...current.message];
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        // Live counter: take the server's word for it every page.
        total: page.total,
        hasOlder: page.hasMore,
        // `nextPosition` keeps a monotonic floor even though it is no longer a
        // validation input, because it is the allocator watermark
        // `allocateAppendedPositions` (sqlDirtyCommit.ts) mints positions for
        // appended messages from. The server value is `MAX(position) + 1` over
        // *committed* rows, so it legitimately sits below positions this
        // session already handed to appended-but-uncommitted messages, and
        // drops outright when the newest message is deleted. Writing it
        // straight through would re-mint a position already in use, and
        // `messages(chat_id, position)` has no UNIQUE constraint, so the
        // collision would only surface much later as tied positions. The floor
        // cannot go stale in a harmful direction: it only ever rises, and an
        // over-estimate merely leaves a gap — reverse paging orders by
        // position and never requires them to be dense.
        nextPosition: Math.max(window.nextPosition ?? page.nextPosition, page.nextPosition),
      });
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      if (counted) endHydration(key);
    }
  });
}
