import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";
import { flushSqlDirtyChanges, isSqlMessageDirty, rebaselineHydratedRootKey } from "./sqlPersistenceRuntime";
import { validateOlderMessagePage } from "../../chatWindow";
import { isMessageMounted } from "../../chatMountRegistry";
import { clearDeferredRootKey, isRootKeyDeferred } from "./deferredRootKeys";
import { isResidencyPinned } from "./residencyPin";
import { drainPluginStorageOverlay, isPluginStoragePerKeyMode } from "./pluginStorageOverlay";
import {
  getSqlPosition,
  getSqlWindow,
  setSqlPosition,
  setSqlWindow,
  type SqlHydrationWindow,
} from "./sqlRuntimeWindow";

export type { SqlHydrationWindow } from "./sqlRuntimeWindow";
type HydratableCharacter = character & { detailsLoaded?: boolean };
type HydratableChat = Chat & {
  messagesLoaded?: boolean;
  messagesFullyLoaded?: boolean;
  detailsLoaded?: boolean;
};

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

/**
 * The page a chat opens on, named for the readers that need to reason about it.
 *
 * `promptHistoryBound.ts` floors its preload target here: whatever the prompt's
 * consumers turn out to need, a send must never leave a chat holding LESS than
 * the window it would have had if nobody had preloaded anything. Exported so
 * that the floor tracks this number instead of restating it.
 */
export const OPEN_PAGE_MESSAGES = DEFAULT_MESSAGE_LIMIT;

/**
 * Upper bound on how many messages of one chat stay in memory.
 *
 * Paging back used to be a one-way ratchet: `loadOlderChatMessages` prepended a
 * page and nothing ever released one, so walking a long history kept every
 * message it touched resident for the rest of the session. The bound is what
 * stops that; the release target is what stops the trimmer from firing on every
 * single page load once the bound is reached.
 *
 * Both are well clear of what a screen can mount at once (`Chats.svelte` mounts
 * at most 60 rows) so that the trimmer is never asked to choose between the
 * bound and a visible row -- and when it is asked anyway, it keeps the row.
 */
export const MAX_RESIDENT_MESSAGES = 320;
export const RESIDENT_RELEASE_TARGET = 240;

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

function getChatDetailStorage(): SqlBootstrapStorage | null {
  const storage = getActiveSqlStorage();
  if (storage?.backendKind !== "server-sql" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadChatHydration !== "function") {
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
    // Per-key mode ends here, and what it was holding has to survive the
    // transition. The map that just arrived is the server's, read before this
    // session's unflushed writes; the overlay holds those writes and the
    // removals a plugin has already been told succeeded. Installing the
    // server's map alone would silently revert every one of them -- the plugin
    // would have written, been told nothing was wrong, and then read its old
    // value back. So the overlay is applied ON TOP, and only then is the
    // baseline taken (below), which is what keeps the still-dirty keys
    // committing.
    if (key === "pluginCustomStorage" && isPluginStoragePerKeyMode()) {
      const map = (record[key] ?? {}) as Record<string, unknown>;
      for (const [storageKey, entry] of drainPluginStorageOverlay()) {
        if (entry.present) map[storageKey] = entry.value;
        else delete map[storageKey];
      }
      record[key] = map;
    }
    clearDeferredRootKey(key);
    // Same synchronous step as the install: the audit baseline must adopt what
    // storage returned, before any caller can mutate it. Left to the next idle
    // audit instead, the unknown -> known transition would adopt the mutated
    // value as the baseline and drop those writes.
    rebaselineHydratedRootKey(db, key);
    // What is installed, not what storage returned. For plugin storage those
    // differ by exactly this session's unflushed writes, and a caller that used
    // the returned value would be reading the map from before them -- the same
    // silent revert the merge above exists to prevent, one indirection out.
    // Today's callers all read back through `db`; this keeps the next one safe.
    return record[key];
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
 * Release messages from the newest end of a resident slice until it fits the
 * bound, and return the window that describes what is left.
 *
 * Direction is not arbitrary. Residency only grows through
 * `loadOlderChatMessages`, and that is triggered when the user is at the oldest
 * resident message and walking further back, so the newest end is the far end
 * from where they are looking. Trimming the oldest end would cut exactly the
 * page they just asked for.
 *
 * Releasing is not deleting. Nothing is marked deleted, no manifest is
 * rewritten, and the returned window records `hasNewer` so that every
 * completeness reader -- export, merge, backup, the dirty-commit manifest, the
 * idle audit -- keeps seeing a partial history. The caller pairs that with
 * `messagesFullyLoaded = false`; the audit reads that flag before it is allowed
 * to turn an id it cannot see into a DELETE, and a trimmed slice must never
 * clear that gate.
 *
 * A message is released only when all five of these hold, and the walk stops at
 * the first one that does not, newest first:
 *
 *   - it has a `chatId`, so it has a durable identity to be found by again;
 *   - it is not mounted -- `Chats.svelte` draws the screen from what it has
 *     mounted, so releasing a mounted row is a hole nothing repaints;
 *   - it is not dirty -- `buildSqlDirtyCommit` resolves a dirty id by looking it
 *     up in `chat.message` and skips ids it cannot find, so a message spliced
 *     out while it still carries an unflushed edit loses that edit silently;
 *   - it carries a canonical persisted position, which is the evidence that it
 *     exists in storage at a known place. Without one, "release" would be
 *     indistinguishable from discarding a message that was never saved;
 *   - the slice is still above the release target.
 *
 * `message` is spliced in place. Handing `Chats.svelte` a different array
 * unmounts the whole conversation and leaves the screen blank.
 */
function releaseNewestResidentMessages(
  chat: Chat,
  chatId: string,
  window: SqlHydrationWindow,
): SqlHydrationWindow {
  const messages = chat.message;
  if (!Array.isArray(messages) || messages.length <= MAX_RESIDENT_MESSAGES) return window;
  // A streaming chat is writing into its own tail. The streaming row is mounted
  // and its text is not yet persisted, so both guards below would already stop
  // the walk; refusing outright says so once instead of relying on that.
  if (chat.isStreaming) return window;
  // Someone is depending on the newest end staying where it is: a generation is
  // in flight over this chat, or the prompt preload is walking backwards
  // through the history precisely so that generation has something to build a
  // prompt from. Paging a long history past the bound would otherwise trim the
  // tail the reply is about to be appended to -- the load that exists to make
  // the send whole would be the thing that truncated it. See `residencyPin.ts`.
  if (isResidencyPinned(chatId)) return window;

  let keep = messages.length;
  while (keep > RESIDENT_RELEASE_TARGET) {
    const candidate = messages[keep - 1];
    const id = candidate?.chatId;
    if (!id || isMessageMounted(id) || isSqlMessageDirty(chatId, id)) break;
    if (!Number.isSafeInteger(getSqlPosition(candidate))) break;
    keep -= 1;
  }
  const releaseCount = messages.length - keep;
  if (releaseCount === 0) return window;

  // The boundary is the fact that makes the release reversible: it names where
  // the resident slice now ends, so `loadNewestChatMessages` knows there is
  // something beyond it and where. Without a position to record we would be
  // claiming `hasNewer` with no way to say from where, so nothing is released.
  const boundary = getSqlPosition(messages[keep - 1]);
  if (!Number.isSafeInteger(boundary)) return window;

  messages.splice(keep, releaseCount);
  return { ...window, hasNewer: true, nextAfter: boundary! };
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
  /** Resident messages that carry a canonical position, i.e. that storage holds. */
  persistedResidentCount: number,
): void {
  // `before` is the boundary contract: the page must start exactly where this
  // window said it would.
  //
  // `nextPosition` and `total` are not part of it, for the same reason. Both are
  // snapshots of the tail taken when the window was built, and the user moves
  // the tail legitimately: a deletion changes `total`, and sending a message
  // while this page is still in the air advances `nextPosition`, because the
  // commit that allocates the appended row's position writes it back into the
  // window. Reading either as corruption made the page throw -- so a reply sent
  // during a scroll stranded the rest of the history behind it and put
  // "could not load older messages" on screen for doing nothing wrong. The
  // fresh values are adopted below: `total` from the page, `nextPosition` as
  // the max of the two, since a local append is ahead of what the server saw.
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
  // Coverage counts resident ids against the persisted total, so it only means
  // anything while the window still holds the newest end -- the resident set is
  // then everything from this page to the end of the history. Once residency
  // trimming has released messages from the newest end the resident count is
  // deliberately smaller than the history, and this rule would reject the last
  // page of every trimmed chat, stranding the start of its history behind a
  // throw. Nothing is lost by skipping it: the rule exists to stop a short
  // terminal page from marking a chat complete, and a trimmed window is never
  // marked complete -- `hasNewer` holds `messagesFullyLoaded` at false.
  //
  // `persistedResidentCount`, not the whole resident set, is what may be
  // measured against `page.total`. A message the user has just sent is resident
  // and carries no canonical position, because nothing has written it yet; it
  // is not part of the history this page's COUNT(*) describes. Counting it made
  // every terminal page throw for a reader who sent a message while scrolling
  // back -- "이전 메시지를 불러오지 못했습니다" at the top of the scrollback,
  // and, because the throw leaves `hasOlder` true, the greeting hidden for the
  // rest of the session.
  //
  // `<` rather than `!==` for the same reason `total` was already dropped from
  // the boundary contract: the count is a snapshot. A commit that lands between
  // the server taking it and this check can leave a resident message both
  // positioned and outside `total`. Being over the count is a race; being under
  // it is a page that did not deliver the history it claimed, which is what
  // this guards.
  if (!page.hasMore && !window.hasNewer && persistedResidentCount + seen.size < page.total) {
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
      // Read the slot back rather than returning `normalized`. `db.characters`
      // is a `$state` array, so what was stored is a PROXY of `normalized`, and
      // a Svelte 5 proxy never writes through to its target. A caller handed
      // `normalized` would be editing an object that is no longer in the
      // database: no UI update, no dirty mark, nothing persisted.
      return db.characters[currentIndex] ?? normalized;
    } finally {
      characterHydrations.delete(characterId);
    }
  })();
  characterHydrations.set(characterId, hydration);
  return hydration;
}

/**
 * Everything a bootstrap chat summary already carries, plus the two runtime
 * flags that describe *this process* rather than the user's data.
 *
 * A summary is `summaryChat()` in `relational-sqlite.cjs`: `id`, `name`, `note`,
 * `folderId`, `lastDate` (the five that are real columns on the `chats` table),
 * an empty `message`, and the residency bookkeeping. Every one of them is
 * already correct on the live slot, from the bootstrap, so re-applying them
 * from a detail response could only overwrite a rename or a folder move the
 * user made while the request was in the air. They are skipped.
 *
 * `isStreaming` and `activeStreamingDisplayOptimizationMode` are skipped for a
 * different reason: `sqlChatData` does not strip them, so a chat whose process
 * died mid-stream has `isStreaming: true` sitting in `chat_extension_nodes`
 * forever. `setDatabase` clears that for chats present at boot; a chat hydrated
 * later would otherwise re-import it and be stuck showing a stream that no one
 * is writing.
 *
 * Everything NOT in this set is what was being lost: `localLore`, `fmIndex`,
 * `firstMessageDisabled`, `scriptstate`, `modules`, `hypaV3Data`, `supaMemory`,
 * `bookmarks`, `bookmarkNames`, `useLocallySetGlobalVariables`,
 * `GLGlobalVariables`, `savedToggleValues`, `useModelPreset`, `modelBinding`,
 * `usePromptPresetParams`, `bindedBotPreset`, `bindedPersona`, `sdData`,
 * `suggestMessages`, and the four `risuBard*` fields.
 */
const SUMMARY_ONLY_CHAT_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "note",
  "folderId",
  "lastDate",
  "message",
  "messageTotal",
  "messagesLoaded",
  "messagesFullyLoaded",
  "detailsLoaded",
  "_placeholder",
  "_stub",
  "isStreaming",
  "activeStreamingDisplayOptimizationMode",
]);

const chatDetailHydrations = new Map<string, Promise<Chat | null>>();

/**
 * Fill in one chat's own stored settings.
 *
 * The bootstrap ships chats as summaries -- four columns and nothing else --
 * and until this existed nothing ever fetched the rest. `chat_extension_nodes`
 * was written on every commit and read by nobody, so a per-chat lorebook, an
 * alternate-greeting index, a bound persona or preset survived only until the
 * next flush, at which point `sqlChatData` serialised the client's summary and
 * `replaceNodes` deleted the stored rows and inserted that in their place.
 *
 * Three properties this has to hold, each of which has burned this codebase
 * before:
 *
 *  - the fields are applied INTO the live slot, never by replacing it. `chats`
 *    is a `$state` array; assigning a rebuilt object stores a *proxy of* it, so
 *    the object the caller built is not the object the application then reads,
 *    and it would also drop the symbol-keyed hydration window and every
 *    canonical message position along with the resident messages themselves;
 *  - `message` is never touched. The detail response's `message` is `[]` by
 *    construction and the resident window is the caller's;
 *  - `detailsLoaded` becomes `true` only after the fields are in. A read that
 *    404s or throws leaves it `false`, which is what keeps
 *    `buildSqlDirtyCommit`'s guard refusing to write the chat. "Could not load"
 *    must never be storable as "has nothing".
 *
 * A key the slot already owns is left alone. A summary owns none of these keys,
 * so an own key here means something wrote it locally after boot -- a toggle
 * flipped while the request was in the air -- and the live value is newer than
 * the stored one.
 */
export async function ensureChatDetailsHydrated(
  chats: Chat[],
  chatIndex: number,
  chaId: string,
): Promise<Chat | null> {
  const initial = chats[chatIndex];
  if (!initial) return null;
  // `!== false` rather than `!`: a chat created in this session has no
  // `detailsLoaded` key at all and is already its own complete record. Only the
  // explicit `false` a bootstrap summary carries means "there is more in
  // storage than is here".
  if ((initial as HydratableChat).detailsLoaded !== false) return initial;
  const storage = getChatDetailStorage();
  if (!storage) return initial;
  const chatId = initial.id;
  if (!chatId) return null;

  const key = `${chaId}/${chatId}`;
  const existing = chatDetailHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      const stored = await storage.loadChatHydration(chatId);
      // Re-derive the slot after the await, the same way `ensureCharacterHydrated`
      // and `loadOlderChatMessages` do: a trigger, a chat deletion or a reorder
      // may have moved or replaced it while the request was out, and writing
      // into the object we started from would write into a detached one.
      const currentIndex = chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : chats[currentIndex];
      if (!current) return null;
      if ((current as HydratableChat).detailsLoaded !== false) return current;
      if (!stored) {
        // The server does not have this chat. That is not "this chat has no
        // settings", so the marker stays `false` and the commit guard keeps
        // refusing to write the summary over whatever storage does hold.
        console.error(
          `[SQL hydration] chat ${chatId} has a bootstrap summary but no stored row, so its own ` +
          "settings could not be read. Leaving it marked unloaded; it will not be written back.",
        );
        return current;
      }

      beginHydrationApply(key);
      try {
        for (const [name, value] of Object.entries(stored)) {
          if (SUMMARY_ONLY_CHAT_KEYS.has(name)) continue;
          if (Object.hasOwn(current, name)) continue;
          (current as unknown as Record<string, unknown>)[name] = value;
        }
        // Last, and only here. Everything above is what makes the claim true.
        (current as HydratableChat).detailsLoaded = true;
        // `endHydrationApply` in a `finally` for the same reason every other
        // apply window here does it: a leaked count defers this chat's dirty
        // marks against a window that never closes, which loses them.
        await tick();
      } finally {
        endHydrationApply(key);
      }
      // Read the slot back. `chats` is a `$state` array and `current` is already
      // the proxy in it, but returning the indexed read keeps this honest if a
      // caller ever hands in a plain array.
      return chats[currentIndex] ?? current;
    } finally {
      endHydration(key);
      chatDetailHydrations.delete(key);
    }
  })();
  chatDetailHydrations.set(key, hydration);
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
        // The newest page is where reverse paging starts, so this window holds
        // the newest end by construction. Only residency trimming can change
        // that, and it replaces the window when it does.
        hasNewer: false,
        nextAfter: null,
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
      // `endHydrationApply` in a `finally`: an apply count that leaks is a chat
      // whose dirty marks are deferred against a window that never closes, and
      // a deferred mark that never runs is the same silent loss as a dropped
      // one.
      try { await tick(); } finally { endHydrationApply(key); }
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
      const persistedResidentCount = current.message.reduce(
        (count, message) => count + (Number.isSafeInteger(getSqlPosition(message)) ? 1 : 0),
        0,
      );
      validateOlderReversePage(page, window, known, persistedResidentCount);
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
        // Prepending does not touch the newest end, so whatever this window
        // already knew about it carries forward; the trim below is the only
        // thing that can change it.
        hasNewer: window.hasNewer,
        nextAfter: window.nextAfter,
        nextPosition: Math.max(window.nextPosition, page.nextPosition),
      };

      insertMessages(current.message, older, "start");
      const boundedWindow = releaseNewestResidentMessages(current, chatId, nextWindow);
      (current as HydratableChat).messagesLoaded = true;
      // A trimmed slice is not the full history even when the page that
      // triggered the trim reached the start of it. `messagesFullyLoaded` is
      // the flag the idle audit reads before it may turn a missing id into a
      // DELETE, and every export/backup/merge guard reads it too, so the
      // released newer end has to clear it.
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore && !boundedWindow.hasNewer;
      setSqlWindow(current, boundedWindow);
      beginHydrationApply(key);
      // `endHydrationApply` in a `finally`: an apply count that leaks is a chat
      // whose dirty marks are deferred against a window that never closes, and
      // a deferred mark that never runs is the same silent loss as a dropped
      // one.
      try { await tick(); } finally { endHydrationApply(key); }
      return current;
    } finally {
      endHydration(key);
      chatHydrations.delete(key);
    }
  })();
  chatHydrations.set(key, hydration);
  return hydration;
}

/**
 * Bring the resident slice back to the newest end of the history after
 * residency trimming released it.
 *
 * This is the return path for {@link releaseNewestResidentMessages}. Trimming
 * is what bounds memory; without a way back the user who paged deep into a long
 * history would be left looking at a chat whose newest messages had vanished
 * from the screen, which reads as data loss even though nothing was deleted.
 *
 * The backend serves reverse pages only -- `before`, never `after` -- so there
 * is no way to walk forward one page at a time. The newest page, though, is
 * exactly what a `before`-less request returns, so this resets the window to it
 * and releases the older slice: the same operation the "latest" control already
 * means. The result is indistinguishable from a freshly opened chat.
 *
 * Nothing is released until every message about to go is provably safe to
 * release, and that check runs before the array is touched:
 *
 *   - pending local changes are flushed first, and any message still dirty
 *     afterwards aborts the whole operation. `buildSqlDirtyCommit` finds dirty
 *     rows by looking them up in `chat.message`, so releasing one would drop the
 *     edit with no error anywhere;
 *   - a message with no canonical persisted position is not known to be in
 *     storage at all, so releasing it would be discarding it.
 *
 * Both refusals throw. A silent fallback here is a chat quietly losing edits.
 */
export async function loadNewestChatMessages(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const chat = character.chats[chatIndex];
  const window = chat && getSqlWindow(chat);
  // No window, or a window that never released its newest end: the resident
  // slice already ends where the history does and there is nothing to restore.
  if (!chat || !window || !window.hasNewer) return chat ?? null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return chat;
  const chatId = chat.id;
  if (!chatId) return null;
  const key = `${character.chaId}/${chatId}`;
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    // Flushed before the hydration guard opens, because `beginHydration` is
    // what suppresses dirty marking -- and inside the registered promise, so a
    // concurrent caller shares this flush instead of racing a second one.
    await flushSqlDirtyChanges();
    beginHydration(key);
    try {
      const page = await storage.loadChatMessageReversePage(chatId, undefined, normalizeLimit(limit));
      const currentIndex = character.chats.findIndex((value) => value?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;

      // Everything that can throw runs first, against the page's own objects
      // and against a plan rather than the live array, so a refusal leaves the
      // chat exactly as the user last saw it.
      // This is the only path that removes messages because of what a page does
      // NOT contain, so the page has to be worth believing before any of it is
      // acted on. A transient empty or short response would otherwise release
      // the resident slice and leave the chat holding almost nothing -- the
      // page is a view of storage, not an assertion that everything missing
      // from it is gone.
      attachCanonicalPositions(page.messages, page.positions);
      if (page.messages.length === 0 && page.total > 0) {
        throw new Error(
          `Refusing to restore the newest page of chat ${chatId}: the backend returned no ` +
          `messages while reporting ${page.total} in storage. Nothing was released.`,
        );
      }
      if (page.messages.length < Math.min(normalizeLimit(limit), page.total)) {
        throw new Error(
          `Refusing to restore the newest page of chat ${chatId}: it carried ` +
          `${page.messages.length} messages where at least ` +
          `${Math.min(normalizeLimit(limit), page.total)} were expected. Nothing was released.`,
        );
      }
      const arriving = new Set(page.messages.map((message) => message.chatId));
      const resident = current.message ?? [];
      const releasing = resident.filter((message) => !arriving.has(message.chatId));
      for (const message of releasing) {
        const id = message.chatId;
        if (!id || isSqlMessageDirty(chatId, id)) {
          throw new Error(
            `Refusing to release message ${id ?? "(missing id)"} of chat ${chatId} while it still ` +
            "carries an unflushed change; the newest page was not restored.",
          );
        }
        if (!Number.isSafeInteger(getSqlPosition(message))) {
          throw new Error(
            `Refusing to release message ${id} of chat ${chatId}: it has no canonical persisted ` +
            "position, so it is not known to exist in storage.",
          );
        }
      }
      const restoredWindow: SqlHydrationWindow = {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        hasNewer: false,
        nextAfter: null,
        // A message appended during the session may already hold a position
        // past what this page reports; the allocator must never hand that one
        // out twice.
        nextPosition: Math.max(window.nextPosition, page.nextPosition),
      };

      // Splice, never replace: `Chats.svelte` sweeps by identity and a new
      // array unmounts the whole conversation.
      for (let index = resident.length - 1; index >= 0; index -= 1) {
        if (!arriving.has(resident[index].chatId)) resident.splice(index, 1);
      }
      if (!Array.isArray(current.message)) current.message = [];
      insertMessages(current.message, page.messages, "end");
      (current as HydratableChat).messagesLoaded = true;
      // Same coverage rule as the initial page: a terminal page is only the
      // whole history when it actually accounts for every persisted message.
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore && current.message.length >= page.total;
      setSqlWindow(current, restoredWindow);
      beginHydrationApply(key);
      // `endHydrationApply` in a `finally`: an apply count that leaks is a chat
      // whose dirty marks are deferred against a window that never closes, and
      // a deferred mark that never runs is the same silent loss as a dropped
      // one.
      try { await tick(); } finally { endHydrationApply(key); }
      return current;
    } finally {
      endHydration(key);
    }
  })();
  chatHydrations.set(key, hydration);
  // Freed on settle rather than from inside the body, whose `finally` now runs
  // after an `await` that precedes this `set`: clearing from in there would
  // race the registration and could strand a settled promise in the map,
  // turning one failed flush into a chat that can never be restored again.
  const release = () => {
    if (chatHydrations.get(key) === hydration) chatHydrations.delete(key);
  };
  hydration.then(release, release);
  return hydration;
}

/**
 * Load every character that is still a bootstrap summary.
 *
 * Export and backup read the live database, where an unopened character carries
 * only its name, image, chat list and timestamps. Archiving that writes a stub
 * in place of the record, and the loss is invisible until a restore. Callers
 * that are about to serialise the whole database run this first.
 *
 * Throws on the first character that cannot be loaded, naming it. A refused
 * backup is recoverable; a silently incomplete one is not.
 */
export async function hydrateSummaryCharacters(db: Database): Promise<void> {
  for (let index = 0; index < (db.characters?.length ?? 0); index += 1) {
    const character = db.characters[index] as HydratableCharacter | undefined;
    if (!character || character.detailsLoaded !== false) continue;
    const hydrated = await ensureCharacterHydrated(db, index);
    const settled = db.characters[index] as HydratableCharacter | undefined;
    if (!hydrated && settled?.detailsLoaded === false) {
      throw new Error(
        `Character "${settled.name ?? character.chaId}" could not be loaded from storage, so it ` +
        "would be written out as a stub with no description, lorebook or scripts. Nothing was saved.",
      );
    }
  }
}
