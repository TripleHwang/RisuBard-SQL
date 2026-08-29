import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";
import { rebaselineHydratedRootKey } from "./sqlPersistenceRuntime";
import { validateOlderMessagePage } from "../../chatWindow";
import { clearDeferredRootKey, isRootKeyDeferred } from "./deferredRootKeys";
import {
  getSqlWindow,
  setSqlPosition,
  setSqlWindow,
  type SqlHydrationWindow,
} from "./sqlRuntimeWindow";

export type { SqlHydrationWindow } from "./sqlRuntimeWindow";
type HydratableCharacter = character & { detailsLoaded?: boolean };
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
const characterHydrations = new Map<string, Promise<character | null>>();
const chatHydrations = new Map<string, Promise<Chat | null>>();
const rootKeyHydrations = new Map<string, Promise<unknown>>();

function getNodeBootstrapStorage(): SqlBootstrapStorage | null {
  const storage = getActiveSqlStorage();
  if (storage?.backendKind !== "server-sql" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadCharacterHydration !== "function" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadChatMessageReversePage !== "function") {
    return null;
  }
  return storage as SqlBootstrapStorage;
}

function getRootKeyStorage(): SqlBootstrapStorage | null {
  const storage = getActiveSqlStorage();
  if (storage?.backendKind !== "server-sql" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadRootKeyHydration !== "function") {
    return null;
  }
  return storage as SqlBootstrapStorage;
}

/**
 * Loads one deferred root key on demand, installs the real value into `db`, and
 * only then clears its deferred mark.
 *
 * Ordering is the whole point. The mark is what stops `buildSqlDirtyCommit`
 * from turning the key's absence into a DELETE, so it is released strictly
 * after the value is resident. Every failure -- no backend, a transport error,
 * a payload that cannot be trusted -- rejects and leaves the key deferred.
 * There is no path from "could not load" to "known empty".
 *
 * Concurrent callers for the same key share one in-flight request, matching
 * `ensureCharacterHydrated` / `ensureChatMessageWindow`; a rejection is shared
 * too, and the slot is freed so a later call can retry.
 */
export async function ensureRootKeyHydrated(db: Database, key: string): Promise<unknown> {
  if (!key) throw new Error("Cannot hydrate an empty root key");
  const record = db as unknown as Record<string, unknown>;
  // Not deferred means fully known: either it was never withheld, or it has
  // already been loaded. Either way the in-memory value is the truth.
  if (!isRootKeyDeferred(key)) return record[key];

  const existing = rootKeyHydrations.get(key);
  if (existing) return existing;

  const storage = getRootKeyStorage();
  if (!storage) {
    throw new Error(
      `Root key "${key}" is deferred but no SQL backend can load it. ` +
      "It stays deferred; its value is unknown, not empty.",
    );
  }

  const hydration = (async () => {
    const value = await storage.loadRootKeyHydration(key);
    if (value === undefined) {
      throw new Error(
        `SQL backend returned no value for deferred root key "${key}". ` +
        "Keeping it deferred rather than treating it as empty.",
      );
    }
    record[key] = value;
    clearDeferredRootKey(key);
    // Same synchronous step as the install: the audit baseline must adopt what
    // storage returned, before any caller can mutate it. Left to the next idle
    // audit instead, the unknown -> known transition would adopt the mutated
    // value as the baseline and drop those writes.
    rebaselineHydratedRootKey(db, key);
    return value;
  })();
  rootKeyHydrations.set(key, hydration);
  // Freed on settle, not in a `finally` inside the body: a synchronous throw
  // would otherwise run the cleanup before this `set` and strand a permanently
  // rejected promise in the map, turning one transport failure into a
  // never-retryable key.
  const release = () => {
    if (rootKeyHydrations.get(key) === hydration) rootKeyHydrations.delete(key);
  };
  hydration.then(release, release);
  return hydration;
}

function normalizeLimit(limit?: number): number {
  return Math.min(100, Math.max(1, Math.floor(limit ?? DEFAULT_MESSAGE_LIMIT)));
}

/**
 * Positions are what later commits write rows back at. Silently skipping them
 * on a malformed response would leave a window that looks healthy over messages
 * with no canonical position, and the next save would guess -- so a mismatch is
 * refused here, before anything observable has been touched.
 */
function attachCanonicalPositions(messages: Chat["message"], positions: number[] | undefined): void {
  if (messages.length === 0) return;
  if (!positions || positions.length !== messages.length) {
    throw new Error(
      `SQL message page carried ${positions ? positions.length : "no"} positions for ` +
      `${messages.length} messages; refusing to attach them.`,
    );
  }
  for (const [index, message] of messages.entries()) {
    setSqlPosition(message, positions[index]);
  }
}

/**
 * Splice a page into a resident message array. The array object is never
 * replaced.
 *
 * `Chats.svelte` mounts message components imperatively and sweeps every
 * mounted row that is absent from the current array, so handing it a different
 * array unmounts the whole conversation and leaves the screen blank -- even
 * when the new array is perfectly correct. Splicing keeps the identity the
 * mounted components were keyed against.
 *
 * Messages already resident are kept and never re-added. A page is a view of
 * what storage holds, not an assertion that everything missing from it is gone,
 * so a short page or an empty one is structurally incapable of removing a row.
 *
 * Ordering assumption for `"end"`: the newest page is appended after whatever
 * is already resident, because a chat that still has no window holds at most an
 * older prefix of its own history -- a placeholder's empty array, or the
 * survivors of an earlier attempt. Resident messages the page does not mention
 * are therefore treated as older, and the ID dedup is what stops a repeated
 * tail from appearing twice.
 */
function insertMessages(resident: Chat["message"], incoming: Chat["message"], at: "start" | "end"): void {
  const known = new Set(resident.map((message) => message.chatId));
  const added = incoming.filter((message) => !known.has(message.chatId));
  if (added.length === 0) return;
  resident.splice(at === "start" ? 0 : resident.length, 0, ...added);
}

/**
 * Reverse pages are a different contract from forward hydration: every page
 * must terminate exactly at the persisted boundary we asked for. Validate the
 * response before attaching positions or replacing either observable window.
 */
function validateOlderReversePage(
  page: Awaited<ReturnType<SqlBootstrapStorage["loadChatMessageReversePage"]>>,
  window: SqlHydrationWindow,
  knownIds: Set<string | undefined>,
): void {
  // `before` and `nextPosition` are the boundary contract: the page must start
  // exactly where this window said it would. `total` is not part of it. It is a
  // COUNT(*) snapshot taken when the window was built, and any message the user
  // deletes afterwards legitimately moves it -- treating that as corruption made
  // every older page throw for the rest of the session, permanently stranding
  // history behind a single deletion. The fresh count is adopted below instead.
  if (page.before !== window.nextBefore || page.nextPosition !== window.nextPosition) {
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
  if (!page.hasMore && knownIds.size + seen.size !== page.total) {
    throw new Error("Reverse page terminal coverage is incomplete")
  }
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

  const hydration = (async () => {
    try {
      const full = await storage.loadCharacterHydration(characterId);
      if (!full) return null;
      const currentIndex = db.characters.findIndex((value) => value?.chaId === characterId);
      if (currentIndex === -1 || (db.characters[currentIndex] as HydratableCharacter | undefined)?.detailsLoaded !== false) return null;
      const normalized = normalizeHydratedCharacter(full);
      db.characters[currentIndex] = normalized;
      return normalized;
    } finally {
      characterHydrations.delete(characterId);
    }
  })();
  characterHydrations.set(characterId, hydration);
  return hydration;
}

export async function ensureChatMessageWindow(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const initial = character.chats[chatIndex];
  if (!initial) return null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return initial;
  const chatId = initial.id;
  if (!chatId) return null;
  const existingWindow = getSqlWindow(initial);
  if (existingWindow) return initial;
  const key = `${character.chaId}/${chatId}`;
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      const page = await storage.loadChatMessageReversePage(chatId, undefined, normalizeLimit(limit));
      const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;

      // Everything that can throw runs first, and runs against the page's own
      // objects. Attaching canonical positions rejects a page whose positions
      // are not real positions, and it does so while the chat is still exactly
      // as the user last saw it. Nothing below this point can fail, so there is
      // no state in which the chat has been half-updated: the previous
      // implementation replaced `message` before attaching the window and left
      // a truncated, windowless chat behind when the attach threw.
      attachCanonicalPositions(page.messages, page.positions);
      const window: SqlHydrationWindow = {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        nextPosition: page.nextPosition,
      };

      if (!Array.isArray(current.message)) current.message = [];
      insertMessages(current.message, page.messages, "end");
      current._placeholder = false;
      (current as HydratableChat).messagesLoaded = true;
      // A page claiming to be terminal must actually account for the whole
      // history. Trusting `hasMore` alone lets a short or empty terminal page
      // mark a chat complete over a fraction of its messages, and "complete" is
      // what every export, merge and backup guard reads before deciding the
      // history is safe to copy. The reverse-page path enforces the same
      // coverage rule; this one had no equivalent.
      const fullyLoaded = !page.hasMore && current.message.length >= page.total;
      if (!page.hasMore && !fullyLoaded) {
        console.error(
          `[SQL hydration] chat ${chatId} returned a terminal page covering ` +
          `${current.message.length} of ${page.total} messages; leaving it marked incomplete.`,
        );
      }
      (current as HydratableChat).messagesFullyLoaded = fullyLoaded;
      setSqlWindow(current, window);
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      endHydration(key);
      chatHydrations.delete(key);
    }
  })();
  chatHydrations.set(key, hydration);
  return hydration;
}

export async function loadOlderChatMessages(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const chat = character.chats[chatIndex];
  const window = chat && getSqlWindow(chat);
  if (!chat || !window || !window.hasOlder || window.nextBefore === null) return chat ?? null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return chat;
  const chatId = chat.id;
  const key = `${character.chaId}/${chatId}`;
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      const page = await storage.loadChatMessageReversePage(chatId, window.nextBefore ?? undefined, normalizeLimit(limit));
      const currentIndex = character.chats.findIndex((value) => value?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;
      const known = new Set(current.message.map((message) => message.chatId));
      // Use the common ID/total guard at the merge boundary; persisted SQL
      // boundaries and positions are validated below by this backend contract.
      validateOlderMessagePage(
        { offset: 0, total: page.total, messages: page.messages },
        { offset: page.messages.length, total: window.total, ids: [...known].filter((id): id is string => !!id) },
      );
      validateOlderReversePage(page, window, known);
      const olderPairs = page.messages.flatMap((message, index) =>
        !known.has(message.chatId) ? [{ message, position: page.positions?.[index] }] : [],
      );
      const older = olderPairs.map(({ message }) => message);
      if (older.length === 0 && page.hasMore && page.nextBefore === window.nextBefore) {
        setSqlWindow(current, { ...window, hasOlder: false });
        return current;
      }

      // Same ordering rule as the initial page: attach positions to the page's
      // own messages, build the replacement window, and only then touch the
      // chat. `message` is spliced rather than rebuilt with
      // `[...older, ...current.message]`, which allocated a new array and made
      // every already-mounted message component identity-change on a success.
      attachCanonicalPositions(older, olderPairs.map(({ position }) => position));
      const nextWindow: SqlHydrationWindow = {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        nextPosition: Math.max(window.nextPosition, page.nextPosition),
      };

      insertMessages(current.message, older, "start");
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setSqlWindow(current, nextWindow);
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      endHydration(key);
      chatHydrations.delete(key);
    }
  })();
  chatHydrations.set(key, hydration);
  return hydration;
}
