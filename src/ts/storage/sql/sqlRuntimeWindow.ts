import type { Chat, Message } from "../database.svelte";

/**
 * Runtime-only markers attached to live chats and messages by SQL page
 * hydration.
 *
 * These are storage bookkeeping, not user data: they say *how much of a chat is
 * resident* and *where a resident message sits in the persisted order*. They
 * must be reachable from a live `$state` object and must never reach the
 * database.
 *
 * The previous implementation used `Object.defineProperty(..., { enumerable:
 * false })` to get "invisible to serialization". Svelte 5 rejects that on a
 * `$state` proxy outright -- `proxy.js` throws `state_descriptors_fixed` for any
 * descriptor that is not value-carrying, enumerable, writable and configurable --
 * so every chat opened in SQL mode threw mid-hydration.
 *
 * A symbol key gets the same guarantee by a route the proxy accepts. A plain
 * assignment under a symbol key is an ordinary writable/enumerable/configurable
 * property as far as the proxy is concerned, while `JSON.stringify`,
 * `structuredClone` and `$state.snapshot` -- every path that leads to persistence
 * or to a wire format -- ignore symbol keys entirely. `Object.keys`,
 * `Object.entries` and `for...in` ignore them too, so the legacy save encoder and
 * the diffing fingerprints stay unchanged.
 *
 * `Symbol.for` rather than `Symbol()` is deliberate. Under Vite the same module
 * can be instantiated more than once (SSR graph vs browser graph, or a test
 * transform boundary). Two module instances holding two distinct `Symbol()`
 * values would silently fail to see each other's marks: a chat would look
 * unhydrated to one half of the app and fully loaded to the other -- partial
 * knowledge read as a finished state, the exact failure class this codebase
 * refuses. A registry symbol is the same key in every instance.
 *
 * Nothing outside this module should name these keys. Use the accessors.
 */
const SQL_WINDOW_KEY = Symbol.for("risuvault.sql.hydrationWindow");
const SQL_POSITION_KEY = Symbol.for("risuvault.sql.canonicalPosition");

/**
 * What the runtime knows about the persisted extent of one chat's history.
 *
 * `hasOlder` and `hasNewer` are the load-bearing fields: either being `true`
 * means messages exist in storage that are not in `chat.message`. Anything that
 * would write the whole message list back, export it, back it up, or treat it
 * as the complete history must consult {@link isSqlWindowPartial}, which reads
 * both. Reading only one of them is how a trimmed slice gets mistaken for a
 * whole history -- and a whole history is what the idle audit is allowed to
 * turn absences in into DELETEs.
 */
export type SqlHydrationWindow = {
  /** Position boundary this page was requested before (`null` for the newest page). */
  before: number | null;
  /** Boundary to request next when walking backwards; `null` at the start of history. */
  nextBefore: number | null;
  /** Total persisted message count for the chat, not the resident count. */
  total: number;
  /** True when storage holds messages older than the resident window. */
  hasOlder: boolean;
  /**
   * True when storage holds messages *newer* than the resident window.
   *
   * Only residency trimming sets this. A window built by hydration always holds
   * the newest end -- reverse paging walks backwards from it -- so `false` here
   * is a fact the constructor knows, not a default anyone is guessing at.
   */
  hasNewer: boolean;
  /**
   * Canonical position of the newest resident message when `hasNewer` is true,
   * so the released newer end can be found again; `null` when the window still
   * holds the newest end and there is nothing beyond it to point at.
   */
  nextAfter: number | null;
  /** Next free persisted position, used to allocate positions for appended messages. */
  nextPosition: number;
};

type WindowCarrier = { [SQL_WINDOW_KEY]?: SqlHydrationWindow };
type PositionCarrier = { [SQL_POSITION_KEY]?: number };

/** A chat-shaped value; hydration marks are attached to live `$state` chats. */
type ChatLike = Chat | (object & { message?: unknown });
/** A message-shaped value. */
type MessageLike = Message | object;

/**
 * The lazy-loading window attached during hydration, or `undefined` when this
 * chat has never been hydrated from a SQL page.
 *
 * `undefined` means "no window recorded", which is not the same as "no older
 * messages" -- callers that need the latter must ask {@link hasOlderSqlMessages}
 * or check the chat's own `messagesLoaded` / `messagesFullyLoaded` flags.
 */
export function getSqlWindow(chat: ChatLike | null | undefined): SqlHydrationWindow | undefined {
  if (!chat || typeof chat !== "object") return undefined;
  return (chat as WindowCarrier)[SQL_WINDOW_KEY];
}

/**
 * Record the window for a chat. Callers replace the whole window rather than
 * mutating the previous one, so a half-updated window can never be observed.
 */
export function setSqlWindow(chat: ChatLike, window: SqlHydrationWindow): void {
  (chat as WindowCarrier)[SQL_WINDOW_KEY] = window;
}

/**
 * Forget the window. Use when a chat slot stops being a hydrated view of
 * storage -- eviction back to a placeholder, or a slot replaced wholesale --
 * so the next read re-hydrates instead of trusting a window that describes a
 * message array which is no longer there.
 */
export function clearSqlWindow(chat: ChatLike): void {
  delete (chat as WindowCarrier)[SQL_WINDOW_KEY];
}

/**
 * True only when a window is present *and* says storage holds older messages.
 *
 * Deliberately false for a chat with no window: absence of a window is absence
 * of evidence, and every caller of this predicate pairs it with `_placeholder`,
 * `messagesLoaded === false` and `messagesFullyLoaded === false`, which are the
 * checks that catch "not hydrated at all".
 */
export function hasOlderSqlMessages(chat: ChatLike | null | undefined): boolean {
  return getSqlWindow(chat)?.hasOlder === true;
}

/**
 * True only when a window is present *and* says storage holds newer messages --
 * the resident slice was trimmed at its newest end to bound memory, so
 * `chat.message` no longer ends where the history does.
 *
 * Same reading as {@link hasOlderSqlMessages}: false for a chat with no window,
 * because absence of a window is absence of evidence, not evidence that the
 * newest end is resident. Callers that need "is this the whole history" ask
 * {@link isSqlWindowPartial} and pair it with `_placeholder` /
 * `messagesLoaded` / `messagesFullyLoaded`.
 */
export function hasNewerSqlMessages(chat: ChatLike | null | undefined): boolean {
  return getSqlWindow(chat)?.hasNewer === true;
}

/**
 * True when the hydration window says storage holds messages the resident array
 * does not, in either direction.
 *
 * This is the predicate every completeness guard must use. `hasOlder` alone was
 * sufficient only while residency could only grow; once the newest end can be
 * released too, a check that reads `hasOlder` on a chat paged back to the start
 * of its history sees `false` and calls a trimmed slice complete. Export,
 * merge, backup and the dirty-commit manifest all decide whether to copy or
 * rewrite a whole history from this answer, and the idle audit turns a message
 * id it cannot see in a "complete" history into a DELETE.
 */
export function isSqlWindowPartial(chat: ChatLike | null | undefined): boolean {
  const window = getSqlWindow(chat);
  return window?.hasOlder === true || window?.hasNewer === true;
}

/**
 * How many messages the CONVERSATION has, as opposed to how many are resident.
 *
 * `chat.message.length` answers the second question and is routinely mistaken
 * for the first: a chat opens on its newest 40 messages, so on any long
 * conversation the resident count is a slice. Anything that offers the reader a
 * position in the conversation -- "rebuild the wiki from message 200" -- has to
 * count the whole thing, or it presents a range that stops at 39 and rejects a
 * message that is there.
 *
 * The window's `total` is the persisted count as of the last page. Resident can
 * legitimately exceed it (messages added in this session are not persisted
 * yet), so the larger of the two is the answer; a chat with no window at all is
 * not a view of a page and its resident array is the whole history.
 */
export function conversationMessageCount(chat: ChatLike | null | undefined): number {
  const resident = Array.isArray((chat as { message?: unknown })?.message)
    ? ((chat as { message: unknown[] }).message).length
    : 0;
  const total = getSqlWindow(chat)?.total;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(resident, total) : resident;
}

/**
 * The canonical persisted position of a resident message, or `undefined` when
 * none has been attached.
 *
 * `undefined` means the position is unknown, never zero. Callers writing a
 * message back into a partially resident chat must treat it as unknown and
 * refuse the write rather than substituting an array index.
 */
export function getSqlPosition(message: MessageLike | null | undefined): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  return (message as PositionCarrier)[SQL_POSITION_KEY];
}

/**
 * Attach a canonical persisted position.
 *
 * Rejects anything that is not a real position. A message carrying a bogus
 * position is worse than one carrying none: the missing-position path already
 * throws loudly at commit time, while a bogus one would be written into the
 * `messages.position` column and silently reorder or overwrite a row.
 */
export function setSqlPosition(message: MessageLike, position: number): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error(`Refusing to attach a non-positional canonical SQL position: ${String(position)}`);
  }
  (message as PositionCarrier)[SQL_POSITION_KEY] = position;
}

/** Forget a message's canonical position. */
export function clearSqlPosition(message: MessageLike): void {
  delete (message as PositionCarrier)[SQL_POSITION_KEY];
}

type CarriableChat = ChatLike & { message?: unknown };

/** The resident message array of a chat-shaped value, or `[]`. */
function residentMessages(chat: ChatLike | null | undefined): MessageLike[] {
  if (!chat || typeof chat !== "object") return [];
  const messages = (chat as CarriableChat).message;
  return Array.isArray(messages) ? (messages as MessageLike[]) : [];
}

/**
 * Carry the runtime hydration marks from a chat that is being replaced onto the
 * chat that replaces it.
 *
 * The marks are symbol-keyed, which is what keeps them out of `JSON.stringify`,
 * `structuredClone` and `$state.snapshot` -- and therefore out of every wire
 * format and every database row. The cost of that guarantee is that they do not
 * survive a clone either, and the application clones chats. `runTrigger`
 * (process/triggers.ts) works on `safeStructuredClone(arg.chat)` and both output
 * trigger call sites assign the result back over the live slot, because a
 * trigger may legitimately add, remove, edit and reorder messages and wholesale
 * replacement is the semantics triggers are written against.
 *
 * Without this carry, the replacement silently destroys storage bookkeeping the
 * chat still needs:
 *
 *  - the chat loses its hydration window, so `allocateAppendedPositions` has no
 *    `nextPosition` to hand out, the appended reply reaches
 *    `canonicalMessagePosition` with no canonical position, and the row is
 *    refused and retried forever without ever being written. The user watches
 *    the message on screen and it is not in the database;
 *  - `hasOlderSqlMessages` goes false on a chat that genuinely has older
 *    messages on disk, so the greeting gate opens over a partial history and
 *    scroll-driven loading stops asking for older pages.
 *
 * What is carried and what is not:
 *
 *  - the window is copied whole, and only when the replacement has none of its
 *    own. It describes the persisted extent of the chat, which a trigger cannot
 *    change;
 *  - a canonical position is carried only to a message the replacement holds
 *    under the same `chatId`. Positions are canonical SQL positions, not array
 *    indices, so matching by id is what makes this correct across a reorder;
 *  - a message the trigger ADDED matches nothing and is left unmarked on
 *    purpose. It is a new row, and `allocateAppendedPositions` is what assigns
 *    positions to new rows. Inventing one here would write it over an existing
 *    row's position;
 *  - a message the trigger DELETED simply does not match anything in the
 *    replacement, so nothing is carried for it.
 *
 * Call it with the value read back OUT of the slot after the assignment, never
 * with the raw object on its way in. `DBState.db` is a Svelte 5 `$state` proxy
 * and a `$state` proxy never writes through to the object it wraps (`proxy.js`'s
 * `set` trap has no `Reflect.set`), so the object in the slot after an
 * assignment is a *proxy of* the value assigned, and that proxy is what every
 * reader in the application sees. Marking the raw object first happens to work
 * -- the proxy's `get` trap falls through to the target for a key it has no
 * source for -- but only while nothing has read the key through the proxy
 * first: the very first read of an absent key installs a source pinned to
 * `UNINITIALIZED`, and from that moment writes to the raw target are invisible.
 * Writing through the slot has no such ordering condition.
 */
export function carrySqlRuntimeFields(
  from: ChatLike | null | undefined,
  to: ChatLike | null | undefined,
): void {
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return;
  // Nothing was actually replaced -- the slot still holds the same object, marks
  // included. Copying onto itself would be harmless but the early return keeps
  // the no-replacement path free of proxy writes that would notify subscribers.
  if (from === to) return;

  const window = getSqlWindow(from);
  if (window && !getSqlWindow(to)) setSqlWindow(to, window);

  const carried = new Map<string, number>();
  for (const message of residentMessages(from)) {
    const id = (message as { chatId?: unknown }).chatId;
    if (typeof id !== "string" || id.length === 0) continue;
    const position = getSqlPosition(message);
    if (Number.isSafeInteger(position) && position! >= 0) carried.set(id, position!);
  }
  if (carried.size === 0) return;

  for (const message of residentMessages(to)) {
    const id = (message as { chatId?: unknown }).chatId;
    if (typeof id !== "string" || id.length === 0) continue;
    // Never overwrite a position the replacement already carries. A caller that
    // handed us a chat whose messages are already marked knows something we do
    // not, and a position written over a good one is the one failure mode
    // `setSqlPosition` cannot detect.
    if (getSqlPosition(message) !== undefined) continue;
    const position = carried.get(id);
    if (position !== undefined) setSqlPosition(message, position);
  }
}

/**
 * Put `nextChat` into `chats[index]` and carry the runtime hydration marks of
 * the chat it displaces onto whatever the slot then holds.
 *
 * This is the whole of the output-trigger write-back, in one place, so that the
 * ordering it depends on is written down once rather than at each call site.
 * `chats` is a `$state` array in the running application: assigning stores a
 * *proxy of* `nextChat`, and reading the slot back is the only way to reach the
 * object the rest of the application will see. The returned value is that
 * object, and callers must keep it rather than the value they passed in -- a
 * plugin or a later statement writing to the detached raw object is a write
 * that reaches neither the screen nor storage.
 */
export function replaceChatSlotCarryingSqlRuntimeFields<T extends ChatLike>(
  chats: T[],
  index: number,
  nextChat: T,
): T {
  const previous = chats[index];
  chats[index] = nextChat;
  const live = chats[index];
  carrySqlRuntimeFields(previous, live);
  return live;
}

/**
 * Remove every runtime hydration mark from a value on its way to storage.
 *
 * Symbol keys already vanish through `JSON.stringify` and `$state.snapshot`, so
 * this is not what keeps them out of the database -- it is what keeps them out
 * of the in-memory commit payloads and diff fingerprints that are built with
 * object spread and rest destructuring, both of which *do* copy own enumerable
 * symbols. The string-keyed deletes clear marks left by older builds that wrote
 * these as ordinary properties.
 *
 * Mutates and returns the value passed; call it on the copy, never on the live
 * chat.
 */
export function stripSqlRuntimeFields<T extends object>(data: T): T {
  const record = data as T & WindowCarrier & PositionCarrier & Record<string, unknown>;
  delete record[SQL_WINDOW_KEY];
  delete record[SQL_POSITION_KEY];
  delete record._sqlWindow;
  delete record._sqlPosition;
  return data;
}
