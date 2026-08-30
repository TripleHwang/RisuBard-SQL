// @vitest-environment node
/**
 * Sending a message while an older page is being loaded, against a REAL
 * spawned server.
 *
 * Node environment on purpose, for the same reason as
 * `sqlReversePageLive.svelte.test.ts`: happy-dom's `fetch` enforces the
 * same-origin policy and cannot reach `http://127.0.0.1:<port>`.
 *
 * The shape here is the one the user hit: open a chat, scroll back through
 * several older pages, send a message, receive a reply, and let the ordinary
 * persistence path run. Nothing below the HTTP boundary is stubbed -- the rows
 * are read back out of SQLite through the same storage object the app builds at
 * boot.
 */
import { flushSync } from "svelte";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Chat, Database, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { ensureChatMessageWindow, loadOlderChatMessages, MAX_RESIDENT_MESSAGES } = await import("./sqlRuntimeHydration");
const { getSqlWindow } = await import("./sqlRuntimeWindow");
const {
  activateSqlPersistenceRuntime,
  deactivateSqlPersistenceRuntime,
  flushSqlDirtyChanges,
  markSqlMessageDirty,
} = await import("./sqlPersistenceRuntime");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");
type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

/** Long enough that scrolling back crosses several pages, short enough to stay quick. */
const HISTORY = 200;
const PAGE = 20;
/** Comfortably past `MAX_RESIDENT_MESSAGES` (320), so scrolling back trims. */
const TRIMMED_HISTORY = 420;

const CHARACTER_ID = "character-send-during-paging";

let server: ServerHandle;
let storage: InstanceType<typeof NodeSqliteStorage>;

function legacyDatabase(chatIds: Array<{ chatId: string; length: number }>): Database {
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
      chats: chatIds.map(({ chatId, length }, chatIndex) => ({
        id: chatId,
        name: `Chat ${chatIndex}`,
        note: "",
        localLore: [],
        message: Array.from({ length }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: `message ${index}`,
          chatId: `${chatId}-msg-${String(index).padStart(3, "0")}`,
        })),
      })),
    }],
  } as unknown as Database;
}

/**
 * The live database exactly as the app holds it: `$state`, with the chat slot
 * starting as an unhydrated placeholder.
 */
function reactiveDatabase(chatId: string): { db: Database; character: character } {
  const db = $state({
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
  });
  return { db: db as unknown as Database, character: db.characters[0] as unknown as character };
}

/**
 * `sendChat`'s `runCurrentChatFunction` (process/index.svelte.ts:895): every
 * message gets a durable id, and one that did not have one is a new message and
 * is marked dirty. This is where the user's own message enters persistence --
 * the composer pushes it with no id at all.
 */
function runCurrentChatFunction(chat: Chat): void {
  chat.message = chat.message.map((message) => {
    const hadId = Boolean(message.chatId);
    message.chatId ||= `sent-${Math.random().toString(36).slice(2)}`;
    if (!hadId) markSqlMessageDirty(chat.id!, message.chatId!);
    return message;
  });
}

/** Read the whole persisted history back out of SQL, page by page. */
async function persistedMessageIds(chatId: string): Promise<string[]> {
  const ids: string[] = [];
  let before: number | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await storage.loadChatMessageReversePage(chatId, before, 100);
    ids.unshift(...page.messages.map((message) => message.chatId!));
    if (!page.hasMore || page.nextBefore === null) return ids;
    before = page.nextBefore;
  }
  throw new Error("persisted history walk did not terminate");
}

/** Open the chat and scroll back through several older pages, as the app does. */
async function openAndScrollBack(character: character): Promise<void> {
  await ensureChatMessageWindow(character, 0, PAGE);
  flushSync();
  for (let page = 0; page < 3; page += 1) {
    await loadOlderChatMessages(character, 0, PAGE);
    flushSync();
  }
}

describe("a reply received while older pages are loading", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase([
      { chatId: "chat-quiet", length: HISTORY },
      { chatId: "chat-paging", length: HISTORY },
      { chatId: "chat-terminal", length: HISTORY },
      { chatId: "chat-trimmed", length: TRIMMED_HISTORY },
    ]))).toBe(true);
    activeStorage.current = storage;
  }, 60_000);

  afterAll(async () => {
    activeStorage.current = null;
    deactivateSqlPersistenceRuntime();
    await server?.cleanup();
  });

  it("persists a reply when nothing else is in flight", async () => {
    const chatId = "chat-quiet";
    const { db, character } = reactiveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, db);
    await openAndScrollBack(character);

    const chat = character.chats[0];
    chat.message.push({ role: "user", data: "질문", time: Date.now() } as any);
    runCurrentChatFunction(chat);

    const replyId = "reply-quiet";
    chat.message.push({ role: "char", data: "", chatId: replyId, time: Date.now() } as any);
    markSqlMessageDirty(chatId, replyId);
    chat.message.at(-1)!.data = "the reply the user received";
    markSqlMessageDirty(chatId, replyId, true);

    await flushSqlDirtyChanges();

    expect(await persistedMessageIds(chatId)).toContain(replyId);
  }, 60_000);

  it("persists a reply that lands while an older page is still in the air", async () => {
    const chatId = "chat-paging";
    const { db, character } = reactiveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, db);
    await openAndScrollBack(character);

    const chat = character.chats[0];

    // The reader is scrolled back and keeps scrolling while the model answers.
    // Scroll-driven loading fires a page request; it is still in the air when
    // the generation finishes.
    const paging = loadOlderChatMessages(character, 0, PAGE);

    chat.message.push({ role: "user", data: "질문", time: Date.now() } as any);
    runCurrentChatFunction(chat);

    const replyId = "reply-paging";
    chat.message.push({ role: "char", data: "", chatId: replyId, time: Date.now() } as any);
    markSqlMessageDirty(chatId, replyId);
    chat.message.at(-1)!.data = "the reply the user received";
    markSqlMessageDirty(chatId, replyId, true);

    // `createOlderMessageLoader` catches a rejected page and reports it; it
    // never aborts the send. Do the same here so the assertion below is about
    // persistence and not about paging.
    const pagingError = await paging.then(() => null, (error) => error);
    flushSync();
    await flushSqlDirtyChanges();
    expect(pagingError).toBeNull();

    const persisted = await persistedMessageIds(chatId);
    expect(persisted).toContain(replyId);
    expect(persisted).toHaveLength(HISTORY + 2);
  }, 60_000);

  it("persists a reply when the in-flight page is the terminal one", async () => {
    const chatId = "chat-terminal";
    const { db, character } = reactiveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, db);

    // Walk all the way back so the next page is the last one in the history.
    await ensureChatMessageWindow(character, 0, 100);
    flushSync();
    while (getSqlWindow(character.chats[0])?.hasOlder === true) {
      const remaining = getSqlWindow(character.chats[0])!.nextBefore ?? 0;
      if (remaining <= 100) break;
      await loadOlderChatMessages(character, 0, 100);
      flushSync();
    }

    const chat = character.chats[0];
    const paging = loadOlderChatMessages(character, 0, 100);

    chat.message.push({ role: "user", data: "질문", time: Date.now() } as any);
    runCurrentChatFunction(chat);
    const replyId = "reply-terminal";
    chat.message.push({ role: "char", data: "the reply", chatId: replyId, time: Date.now() } as any);
    markSqlMessageDirty(chatId, replyId, true);

    const pagingError = await paging.then(() => null, (error) => error);
    flushSync();
    await flushSqlDirtyChanges();

    expect(pagingError).toBeNull();
    expect(await persistedMessageIds(chatId)).toContain(replyId);
  }, 60_000);

  /**
   * `releaseNewestResidentMessages` fires once the resident slice passes
   * `MAX_RESIDENT_MESSAGES`, which scroll-driven loading crosses routinely. The
   * released end is where a reply would land, and the appended reply carries no
   * canonical position until the commit allocates one, so this is the shape
   * where both the residency guards and the position allocator have to hold.
   */
  it("persists a reply sent after residency trimming released the newest end", async () => {
    const chatId = "chat-trimmed";
    const { db, character } = reactiveDatabase(chatId);
    activateSqlPersistenceRuntime(storage, db);

    await ensureChatMessageWindow(character, 0, 100);
    flushSync();
    let guard = 0;
    while (getSqlWindow(character.chats[0])?.hasOlder === true) {
      await loadOlderChatMessages(character, 0, 100);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }

    const window = getSqlWindow(character.chats[0]);
    expect(window?.hasNewer).toBe(true);
    expect(character.chats[0].message.length).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);

    const chat = character.chats[0];
    chat.message.push({ role: "user", data: "질문", time: Date.now() } as any);
    runCurrentChatFunction(chat);
    const replyId = "reply-trimmed";
    chat.message.push({ role: "char", data: "the reply", chatId: replyId, time: Date.now() } as any);
    markSqlMessageDirty(chatId, replyId, true);

    await flushSqlDirtyChanges();

    const persisted = await persistedMessageIds(chatId);
    expect(persisted).toContain(replyId);
    // Appending must not overwrite a row of the history it can no longer see.
    expect(persisted).toHaveLength(TRIMMED_HISTORY + 2);
    expect(new Set(persisted).size).toBe(persisted.length);
  }, 60_000);
});
