// @vitest-environment node
/**
 * An output trigger replaces the live chat with a structured clone of it, and
 * the message the user just received must still reach SQLite.
 *
 * This is the user's remaining data loss. `runTrigger` (process/triggers.ts:1077)
 * works on `safeStructuredClone(arg.chat)`, and both output-trigger call sites in
 * process/index.svelte.ts assign that clone back over the live chat slot. The SQL
 * layer's runtime bookkeeping -- the hydration window on the chat, the canonical
 * persisted position on each resident message -- is symbol-keyed, and symbols do
 * not survive a clone. So the moment an output trigger runs:
 *
 *  - `allocateAppendedPositions` has no `nextPosition` to hand out, the appended
 *    reply reaches `canonicalMessagePosition` with no canonical position, the row
 *    is refused, left dirty, and retried forever without ever being written;
 *  - `hasOlderSqlMessages` goes false on a chat that genuinely has older messages
 *    on disk, so DefaultChatScreen's greeting gate opens over a partial history.
 *
 * Node environment for the same reason as `sqlProxyPersistenceLive.test.ts`:
 * happy-dom's `fetch` enforces the same-origin policy and cannot reach
 * `http://127.0.0.1:<port>`. Nothing below the HTTP boundary is stubbed -- rows
 * are read back out of SQLite through the same storage object the app builds at
 * boot.
 *
 * Two things about the fixture matter, and both are asserted rather than assumed.
 *
 * The clone is the REAL one. `safeStructuredClone` is reproduced here exactly as
 * `polyfill.ts` writes it, `structuredClone` with an `rfdc` fallback, because the
 * whole defect is that a real clone drops real symbols. A fixture that dropped
 * them by hand would prove nothing. (In practice the fallback is the live path:
 * `structuredClone` throws `DataCloneError` on a Proxy, and the chat the trigger
 * is handed is always a `$state` proxy.)
 *
 * The database is a REAL `$state` proxy, created by calling Svelte's `proxy()`
 * directly. Under `@vitest-environment node` vite-plugin-svelte applies the
 * SERVER transform, where `$state` compiles to a plain assignment and no proxy is
 * created at all -- a fixture declared with `$state` here would let the raw
 * object and the slot be the same object, which is precisely the condition under
 * which this bug is invisible. `proxy()` is the exact call the client build of
 * `$state` makes on assignment (`proxy.js`'s `set` trap runs
 * `set(s, proxy(value))`), and `liveDatabase` below pins the defining property --
 * that it does NOT write through -- so nothing here can pass for the wrong reason.
 */
import rfdc from "rfdc";
import { flushSync } from "svelte";
import { proxy } from "svelte/internal/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Chat, Database, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { ensureChatMessageWindow } = await import("./sqlRuntimeHydration");
const {
  carrySqlRuntimeFields,
  getSqlPosition,
  getSqlWindow,
  hasOlderSqlMessages,
  isSqlWindowPartial,
  replaceChatSlotCarryingSqlRuntimeFields,
} = await import("./sqlRuntimeWindow");
const {
  activateSqlPersistenceRuntime,
  deactivateSqlPersistenceRuntime,
  flushSqlDirtyChanges,
  isSqlMessageDirty,
  markSqlMessageDirty,
} = await import("./sqlPersistenceRuntime");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

/** Long enough that one page leaves plenty on disk, short enough to stay quick. */
const HISTORY = 40;
const PAGE = 8;

const CHARACTER_ID = "character-trigger-clone";

let server: ServerHandle;
let storage: InstanceType<typeof NodeSqliteStorage>;

/** `polyfill.ts` lines 12-21, reproduced so the clone under test is the real one. */
const rfdcClone = rfdc({ circles: true });
function safeStructuredClone<T>(data: T): T {
  try {
    return structuredClone(data);
  } catch {
    return rfdcClone(data);
  }
}

function legacyDatabase(chatIds: string[]): Database {
  return {
    apiType: "openai",
    username: "reporter",
    maxContext: 4000,
    personas: [{ name: "Default", icon: "", personaPrompt: "" }],
    botPresets: [],
    botPresetsId: 0,
    modules: [],
    pluginCustomStorage: {},
    characters: [{
      chaId: CHARACTER_ID,
      type: "character",
      name: "Ada",
      image: "",
      desc: "",
      firstMessage: "Hello, this is the greeting.",
      alternateGreetings: [],
      chatPage: 0,
      chats: chatIds.map((chatId, chatIndex) => ({
        id: chatId,
        name: `Chat ${chatIndex}`,
        note: "",
        localLore: [],
        message: Array.from({ length: HISTORY }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: `message ${index}`,
          chatId: `${chatId}-msg-${String(index).padStart(3, "0")}`,
        })),
      })),
    }],
  } as unknown as Database;
}

/**
 * The live database as the browser holds it: a real `$state` proxy over the raw
 * graph, with the chat slot starting as an unhydrated placeholder.
 *
 * The write-through probe is not decoration. This fixture is only a faithful
 * stand-in for `DBState.db` if writes through it do NOT reach the object it
 * wraps; a fixture that quietly started writing through would make every
 * assertion in this file pass for the wrong reason.
 */
function liveDatabase(chatId: string): { db: Database; character: character } {
  const raw = {
    apiType: "openai",
    characters: [{
      chaId: CHARACTER_ID,
      chatPage: 0,
      chats: [{
        id: chatId,
        name: "Chat 0",
        note: "",
        localLore: [],
        message: [] as any[],
        _placeholder: true,
        messagesLoaded: false,
      }],
    }],
  };
  const db = proxy(raw) as unknown as Database;

  expect(db).not.toBe(raw);
  (db as unknown as Record<string, unknown>).__proxyProbe = "written through the proxy";
  expect((db as unknown as Record<string, unknown>).__proxyProbe).toBe("written through the proxy");
  expect((raw as unknown as Record<string, unknown>).__proxyProbe).toBeUndefined();

  return { db, character: db.characters[0] as unknown as character };
}

/** Read the whole persisted history back out of SQL, page by page. */
async function persistedMessages(
  chatId: string,
): Promise<Array<{ chatId: string; data: string; position: number }>> {
  const rows: Array<{ chatId: string; data: string; position: number }> = [];
  let before: number | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await storage.loadChatMessageReversePage(chatId, before, 100);
    rows.unshift(...page.messages.map((message, index) => ({
      chatId: message.chatId!,
      data: String(message.data ?? ""),
      position: page.positions[index],
    })));
    if (!page.hasMore || page.nextBefore === null) return rows;
    before = page.nextBefore;
  }
  throw new Error("persisted history walk did not terminate");
}

/**
 * `runTrigger` (process/triggers.ts:1077) with the trigger body left out: what
 * every output trigger hands back is a `safeStructuredClone` of the live chat.
 * `normalizeChat` then fills required fields in place and returns that same
 * object, so the value the call site assigns is this raw clone.
 */
function runOutputTrigger(chat: Chat, body: (chat: Chat) => void = () => {}): Chat {
  const cloned = safeStructuredClone(chat);
  body(cloned);
  return cloned;
}

/** Open the chat on its newest page, leaving older messages on disk. */
async function openNewestPage(character: character): Promise<Chat> {
  await ensureChatMessageWindow(character, 0, PAGE);
  flushSync();
  const chat = character.chats[0];
  // The premise of every test below: a partial window over a real history.
  expect(hasOlderSqlMessages(chat)).toBe(true);
  expect(isSqlWindowPartial(chat)).toBe(true);
  expect(chat.message).toHaveLength(PAGE);
  return chat;
}

describe("a chat replaced by an output trigger's structured clone", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase([
      "chat-trigger-append",
      "chat-trigger-window",
      "chat-trigger-reorder",
      "chat-trigger-reorder-commit",
      "chat-trigger-midinsert",
      "chat-input-trigger",
      "chat-reroll",
    ]))).toBe(true);
    activeStorage.current = storage;
  }, 60_000);

  afterAll(async () => {
    activeStorage.current = null;
    deactivateSqlPersistenceRuntime();
    await server?.cleanup();
  });

  /**
   * The user's loss, end to end: send a message, receive a reply, let an output
   * trigger run, and let the ordinary persistence path flush.
   */
  it("still persists the reply appended before the trigger ran", async () => {
    const chatId = "chat-trigger-append";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    // The composer and the generation, both writing through the live slot.
    const sentId = `${chatId}-sent`;
    chat.message.push({ role: "user", data: "질문", chatId: sentId } as never);
    markSqlMessageDirty(chatId, sentId);
    const replyId = `${chatId}-reply`;
    chat.message.push({ role: "char", data: "the reply the user received", chatId: replyId } as never);
    markSqlMessageDirty(chatId, replyId, true);

    // The output trigger, and the write-back the two call sites perform.
    const triggered = runOutputTrigger(chat);
    // The clone really did drop the marks -- this is the defect, measured.
    expect(getSqlWindow(triggered)).toBeUndefined();
    expect(getSqlPosition(triggered.message[0])).toBeUndefined();

    const live = replaceChatSlotCarryingSqlRuntimeFields(character.chats, 0, triggered);
    expect(live).not.toBe(triggered);

    await flushSqlDirtyChanges();

    const persisted = await persistedMessages(chatId);
    expect({
      sent: persisted.find((row) => row.chatId === sentId)?.data ?? null,
      reply: persisted.find((row) => row.chatId === replyId)?.data ?? null,
      count: persisted.length,
      duplicates: persisted.length - new Set(persisted.map((row) => row.chatId)).size,
      // Refused rows stay dirty and retry forever. Written rows do not.
      stillDirty: isSqlMessageDirty(chatId, replyId),
    }).toEqual({
      sent: "질문",
      reply: "the reply the user received",
      count: HISTORY + 2,
      duplicates: 0,
      stillDirty: false,
    });
  }, 60_000);

  /**
   * The greeting gate. `DefaultChatScreen.svelte:1639` draws the character's
   * first message when `atOldestEnd && !hasOlderSqlMessages(currentChatSlot)`.
   * A chat whose window was dropped answers `false` to that predicate while
   * thirty-two of its messages are still on disk, so a partial history is drawn
   * as if it were the whole conversation.
   */
  it("still reports the older messages that are on disk", async () => {
    const chatId = "chat-trigger-window";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const windowBefore = getSqlWindow(chat);
    expect(windowBefore?.total).toBe(HISTORY);

    const triggered = runOutputTrigger(chat);
    const live = replaceChatSlotCarryingSqlRuntimeFields(character.chats, 0, triggered);

    // `messagesFullyLoaded` is a plain field, so it survives the clone on its
    // own and the write guards that read it still hold. Checked, not assumed --
    // the guards below are only meaningful alongside it.
    expect((live as { messagesFullyLoaded?: boolean }).messagesFullyLoaded).toBe(false);

    expect({
      greetingGateWouldOpen: !hasOlderSqlMessages(character.chats[0]),
      partial: isSqlWindowPartial(character.chats[0]),
      window: getSqlWindow(character.chats[0]),
      // Scroll-driven loading walks backwards from `nextBefore`; without it the
      // screen stops asking for older pages.
      nextBefore: getSqlWindow(character.chats[0])?.nextBefore,
    }).toEqual({
      greetingGateWouldOpen: false,
      partial: true,
      window: windowBefore,
      nextBefore: windowBefore!.nextBefore,
    });

    // And the marks live where every reader looks: on the object in the slot,
    // reached through the proxy -- not on the raw object that was assigned.
    expect(getSqlWindow(triggered)).toBeUndefined();
    expect(getSqlWindow(character.chats[0])).toEqual(windowBefore);
  }, 60_000);

  /**
   * A trigger may reorder messages. Positions are canonical SQL positions, not
   * array indices, so each message keeps the position it was hydrated at -- a
   * reversed array does not renumber anything and cannot make two messages
   * claim one row.
   */
  it("carries positions by message id across a reorder, and adds none to new messages", async () => {
    const chatId = "chat-trigger-reorder";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const positionsBefore = new Map(
      chat.message.map((message) => [message.chatId!, getSqlPosition(message)!]),
    );
    expect([...positionsBefore.values()]).toEqual(
      Array.from({ length: PAGE }, (_, index) => HISTORY - PAGE + index),
    );

    const insertedId = `${chatId}-inserted-by-trigger`;
    const droppedId = chat.message[0].chatId!;
    const triggered = runOutputTrigger(chat, (cloned) => {
      cloned.message.reverse();
      cloned.message = cloned.message.filter((message) => message.chatId !== droppedId);
      cloned.message.push({ role: "char", data: "added by the trigger", chatId: insertedId } as never);
    });
    const live = replaceChatSlotCarryingSqlRuntimeFields(character.chats, 0, triggered);

    expect({
      // Every surviving message keeps ITS position, wherever it now sits.
      carried: live.message
        .filter((message) => message.chatId !== insertedId)
        .map((message) => [message.chatId!, getSqlPosition(message)] as const),
      // The message the trigger added is a new row. It must reach the commit
      // unmarked so `allocateAppendedPositions` assigns it, never carrying some
      // existing row's position.
      inserted: getSqlPosition(live.message.at(-1)!),
      // The message the trigger deleted matches nothing and carries nothing.
      droppedStillPresent: live.message.some((message) => message.chatId === droppedId),
    }).toEqual({
      carried: [...positionsBefore]
        .filter(([id]) => id !== droppedId)
        .reverse()
        .map(([id, position]) => [id, position]),
      inserted: undefined,
      droppedStillPresent: false,
    });
  }, 60_000);

  /**
   * What a reorder MEANS once the commit runs, measured rather than assumed.
   *
   * Inside a partial window `canonicalMessagePosition` writes each row at its
   * carried position, so reversing the resident slice writes the same rows back
   * at the same positions and the persisted order does not change. The reorder
   * is not persisted; it is also not corrupted, and no two messages can claim
   * one row. That is the deliberate trade: the alternative -- renumbering by
   * array index -- would write these eight rows over positions 0..7, which in a
   * partial window are eight OTHER messages that are not even resident.
   *
   * A reorder inside a chat whose window is complete does persist: with nothing
   * partial, `canonicalMessagePosition` uses the array index and the message
   * manifest is emitted alongside it.
   */
  it("writes a reordered partial window back at its carried positions, leaving the stored order intact", async () => {
    const chatId = "chat-trigger-reorder-commit";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const storedOrderBefore = (await persistedMessages(chatId)).map((row) => row.chatId);

    const triggered = runOutputTrigger(chat, (cloned) => {
      cloned.message.reverse();
      for (const message of cloned.message) message.data = `${message.data} (touched by trigger)`;
    });
    const live = replaceChatSlotCarryingSqlRuntimeFields(character.chats, 0, triggered);
    for (const message of live.message) markSqlMessageDirty(chatId, message.chatId!, true);

    await flushSqlDirtyChanges();

    const persisted = await persistedMessages(chatId);
    expect({
      order: persisted.map((row) => row.chatId),
      count: persisted.length,
      // The edits the trigger made DO persist -- it is only the ordering that
      // the canonical positions pin.
      editApplied: persisted.at(-1)!.data.endsWith("(touched by trigger)"),
      // ...and only to the rows that were resident. The older half is untouched.
      olderUntouched: persisted[0].data,
    }).toEqual({
      order: storedOrderBefore,
      count: HISTORY,
      editApplied: true,
      olderUntouched: "message 0",
    });
  }, 60_000);

  /**
   * A residual this fix does NOT close, pinned so a later change to it is
   * deliberate.
   *
   * `allocateAppendedPositions` only hands out positions when the unpositioned
   * messages form a contiguous TAIL: it finds the first message with no
   * position and gives up if anything after it has one. A trigger that inserts a
   * new message into the MIDDLE of a partially resident chat therefore leaves
   * that message un-positionable, and the commit refuses it and retries.
   *
   * Before this fix that was the state of EVERY message after any output
   * trigger, because the clone stripped every position and the window with it.
   * Now it is confined to mid-insertion, and the rows around it still commit.
   * Widening the allocator would persist such a message at the end of the
   * stored order rather than where the trigger put it, which is a different
   * trade and not one to make silently.
   */
  it("still refuses a message a trigger inserted into the middle of a partial window", async () => {
    const chatId = "chat-trigger-midinsert";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const midInsertedId = `${chatId}-mid`;
    const tailAppendedId = `${chatId}-tail`;
    const triggered = runOutputTrigger(chat, (cloned) => {
      cloned.message.splice(4, 0, { role: "char", data: "inserted mid-history", chatId: midInsertedId } as never);
      cloned.message.push({ role: "char", data: "appended at the tail", chatId: tailAppendedId } as never);
    });
    const live = replaceChatSlotCarryingSqlRuntimeFields(character.chats, 0, triggered);
    markSqlMessageDirty(chatId, midInsertedId, true);
    markSqlMessageDirty(chatId, tailAppendedId, true);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await flushSqlDirtyChanges();
    error.mockRestore();

    const persisted = await persistedMessages(chatId);
    expect({
      // The mid-insertion is refused and stays dirty, exactly as an
      // un-positionable row must.
      midPersisted: persisted.some((row) => row.chatId === midInsertedId),
      midStillDirty: isSqlMessageDirty(chatId, midInsertedId),
      // Nothing else in the chat is taken down with it.
      resident: live.message.length,
      count: persisted.length,
      duplicates: persisted.length - new Set(persisted.map((row) => row.chatId)).size,
    }).toEqual({
      midPersisted: false,
      midStillDirty: true,
      resident: PAGE + 2,
      count: HISTORY,
      duplicates: 0,
    });

    // Leave no dirty mark behind for the next suite: the registry is module
    // state that survives this file.
    live.message.splice(4, 1);
    await flushSqlDirtyChanges();
    expect(isSqlMessageDirty(chatId, midInsertedId)).toBe(false);
  }, 60_000);

  /**
   * The same class from the other end: the `input` trigger replaces the message
   * ARRAY rather than the chat.
   *
   * `DefaultChatScreen.svelte`'s `sendMain` sets `cha = triggerResult.chat.message`
   * and later assigns that array onto the live chat. The chat object -- and its
   * window -- survives; every resident MESSAGE does not, and each replacement
   * carries no canonical position.
   *
   * That is worse than losing the window, not better. With a window still saying
   * `nextPosition: 40`, `allocateAppendedPositions` sees a chat whose messages
   * are all unpositioned, decides the whole resident slice is an append, and
   * hands the eight already-stored messages positions 40..47. Rows are upserted
   * by message id, so nothing is duplicated -- what happens instead is that any
   * edited resident message MOVES to the end of the conversation, and the
   * user's new message lands at 48 behind a seven-row gap. Measured: without the
   * carry this test reports `editedAt: 40` and `sentAt: 48` where the history
   * ends at 39.
   */
  it("keeps positions when an input trigger replaces the message array", async () => {
    const chatId = "chat-input-trigger";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const triggered = runOutputTrigger(chat, (cloned) => {
      cloned.message[0].data = "edited by the input trigger";
    });

    // DefaultChatScreen.svelte's `sendMain`, exactly.
    const displacedMessages = chat.message;
    chat.message = triggered.message;
    carrySqlRuntimeFields({ message: displacedMessages }, chat);

    const sentId = `${chatId}-sent`;
    chat.message.push({ role: "user", data: "질문", chatId: sentId } as never);
    markSqlMessageDirty(chatId, sentId, true);
    // The trigger's edit to an existing message is dirty too, and that row must
    // update in place rather than being re-appended.
    markSqlMessageDirty(chatId, chat.message[0].chatId!, true);

    await flushSqlDirtyChanges();

    const persisted = await persistedMessages(chatId);
    expect({
      count: persisted.length,
      duplicates: persisted.length - new Set(persisted.map((row) => row.chatId)).size,
      // The user's new message goes immediately after the history, not past a
      // gap left by re-appending the resident slice.
      sentAt: persisted.find((row) => row.chatId === sentId)?.position ?? null,
      // The edit updated the row already at position 32.
      editedAt: persisted.find((row) => row.data === "edited by the input trigger")?.position ?? null,
      residentPositions: chat.message
        .filter((message) => message.chatId !== sentId)
        .map((message) => getSqlPosition(message)),
    }).toEqual({
      count: HISTORY + 1,
      duplicates: 0,
      sentAt: HISTORY,
      editedAt: HISTORY - PAGE,
      residentPositions: Array.from({ length: PAGE }, (_, index) => HISTORY - PAGE + index),
    });
  }, 60_000);

  /**
   * The same class again, and no trigger is involved at all: `reroll()` in
   * `DefaultChatScreen.svelte`.
   *
   * Regenerating a reply clones the live message array
   * (`safeStructuredClone(...chats[...].message)`), pops back to the last user
   * message, and assigns the clone over the live array. The chat object is
   * untouched, so its hydration window survives; every resident message is
   * replaced by a copy that carries no canonical position.
   *
   * That is the damaging combination. `allocateAppendedPositions` reads a
   * window still saying `nextPosition: 40` over a slice where nothing is
   * positioned, decides the whole slice is an append, and renumbers it to
   * 40..46. Only the rows that are dirty get written at the new numbers, so a
   * message the user edits after a reroll leaves position 32 and lands at 40 --
   * past six messages it used to sit before -- while its untouched neighbours
   * stay where they were. Measured without the carry: `editedAt: 40`,
   * `replyAt: 47`, and a stored order with the edited message moved to the end.
   */
  it("keeps positions when reroll replaces the message array with a clone", async () => {
    const chatId = "chat-reroll";
    const { db, character } = liveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, () => db);
    const chat = await openNewestPage(character);

    const storedOrderBefore = (await persistedMessages(chatId)).map((row) => row.chatId);

    // `reroll()`, exactly: clone the live array, drop the last char message,
    // assign the clone back, carry the marks off the array being displaced.
    const displacedMessages = chat.message;
    const cha = safeStructuredClone(displacedMessages);
    cha.pop();
    chat.message = cha;
    carrySqlRuntimeFields({ message: displacedMessages }, chat);

    // The regenerated reply is a new row and must reach the commit unmarked.
    const replyId = `${chatId}-regenerated`;
    chat.message.push({ role: "char", data: "regenerated reply", chatId: replyId } as never);
    markSqlMessageDirty(chatId, replyId, true);
    // ...and an edit to a message that survived the reroll, which is where the
    // renumbering shows: it must update the row it already owns.
    const editedId = chat.message[0].chatId!;
    chat.message[0].data = "edited after the reroll";
    markSqlMessageDirty(chatId, editedId, true);

    await flushSqlDirtyChanges();

    const persisted = await persistedMessages(chatId);
    expect({
      residentPositions: chat.message
        .filter((message) => message.chatId !== replyId)
        .map((message) => getSqlPosition(message)),
      editedAt: persisted.find((row) => row.chatId === editedId)?.position ?? null,
      replyAt: persisted.find((row) => row.chatId === replyId)?.position ?? null,
      order: persisted.map((row) => row.chatId),
      duplicates: persisted.length - new Set(persisted.map((row) => row.chatId)).size,
    }).toEqual({
      residentPositions: Array.from({ length: PAGE - 1 }, (_, index) => HISTORY - PAGE + index),
      editedAt: HISTORY - PAGE,
      replyAt: HISTORY,
      order: [...storedOrderBefore, replyId],
      duplicates: 0,
    });
  }, 60_000);
});
