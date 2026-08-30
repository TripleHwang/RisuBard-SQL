// @vitest-environment node
/**
 * Reverse paging against a REAL spawned server, not a fixture.
 *
 * Node environment on purpose: happy-dom's `fetch` enforces the same-origin
 * policy and refuses to talk to `http://127.0.0.1:<port>`, so a DOM environment
 * cannot reach a real server at all. Nothing in this file needs a document --
 * the chat slot is a Svelte 5 `$state` proxy, which is plain runtime code.
 *
 * Every previous test of the reverse-page boundary drove
 * `validateOlderReversePage` with hand-built page objects whose terminal page
 * carried `nextBefore: null`. The real server never sent that: it answered with
 * the minimum position of the rows it returned, on every page, terminal or not.
 * So the fixtures agreed with the client and disagreed with the only thing that
 * actually serves pages, and the terminal page of every chat longer than one
 * page threw "Reverse page boundary is noncontiguous" in front of the user
 * while 2900 tests stayed green.
 *
 * Nothing here is stubbed below the HTTP boundary. `server.cjs` runs in its own
 * process against its own temporary save directory, the chat is migrated
 * through `/api/sql/commit`, and the pages come back over `/api/sql/chats/:id/
 * messages` through the same `NodeSqliteStorage` the app builds at boot.
 */
import { flushSync } from "svelte";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { ensureChatMessageWindow, loadOlderChatMessages } = await import("./sqlRuntimeHydration");
const { getSqlWindow, hasOlderSqlMessages, isSqlWindowPartial } = await import("./sqlRuntimeWindow");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");
type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

/** Longer than one page and not a multiple of it, so the last page is short. */
const HISTORY = 95;
const PAGE = 40;

const CHAT_ID = "chat-live-reverse";
const CHARACTER_ID = "character-live-reverse";

function legacyDatabase(): Database {
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
      chats: [{
        id: CHAT_ID,
        name: "Chat 0",
        note: "",
        localLore: [],
        message: Array.from({ length: HISTORY }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: `message ${index}`,
          chatId: `msg-${String(index).padStart(3, "0")}`,
        })),
      }],
    }],
  } as unknown as Database;
}

/** The chat slot exactly as the app holds it: a Svelte 5 `$state` proxy. */
function reactiveCharacter(): character {
  const state = $state({
    chaId: CHARACTER_ID,
    chatPage: 0,
    chats: [{
      id: CHAT_ID,
      name: "Chat 0",
      note: "",
      localLore: [],
      message: [] as any[],
      _placeholder: true,
      messagesLoaded: false,
    }],
  });
  return state as unknown as character;
}

let server: ServerHandle;

describe("reverse paging against a live server", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    const storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase())).toBe(true);
    activeStorage.current = storage;
  }, 60_000);

  afterAll(async () => {
    activeStorage.current = null;
    await server?.cleanup();
  });

  beforeEach(() => {
    // The chat slot is rebuilt per test; the storage client is shared.
  });

  it("pages a real chat to the start of its history without throwing", async () => {
    const character = reactiveCharacter();

    await ensureChatMessageWindow(character, 0, PAGE);
    flushSync();
    expect(character.chats[0].message).toHaveLength(PAGE);
    expect(hasOlderSqlMessages(character.chats[0])).toBe(true);

    // Walk backwards the way the scroll loader does. A throw from any page --
    // including the terminal one -- fails here instead of being swallowed into
    // a toast the way the app swallows it.
    let guard = 0;
    while (hasOlderSqlMessages(character.chats[0])) {
      await loadOlderChatMessages(character, 0, PAGE);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }

    const chat = character.chats[0];
    expect(chat.message).toHaveLength(HISTORY);
    expect(chat.message.map((message: any) => message.chatId)).toEqual(
      Array.from({ length: HISTORY }, (_, index) => `msg-${String(index).padStart(3, "0")}`),
    );
    // The start of history really was reached, and the window says so.
    expect(hasOlderSqlMessages(chat)).toBe(false);
    expect(isSqlWindowPartial(chat)).toBe(false);
    expect((chat as any).messagesFullyLoaded).toBe(true);
    expect(getSqlWindow(chat)?.nextBefore).toBeNull();
  }, 60_000);

  it("opens the greeting gate once the start of history is loaded", async () => {
    const character = reactiveCharacter();

    await ensureChatMessageWindow(character, 0, PAGE);
    flushSync();

    // `DefaultChatScreen.svelte` draws the greeting on
    // `atOldestEnd && !hasOlderSqlMessages(currentChatSlot)`. `atOldestEnd`
    // is the DOM half; this is the storage half, and it is the half that
    // stayed true forever once the terminal page threw.
    const greetingGate = () => !hasOlderSqlMessages(character.chats[0]);
    expect(greetingGate()).toBe(false);

    let guard = 0;
    while (hasOlderSqlMessages(character.chats[0])) {
      await loadOlderChatMessages(character, 0, PAGE);
      flushSync();
      if ((guard += 1) > 20) throw new Error("reverse paging did not terminate");
    }

    expect(greetingGate()).toBe(true);
  }, 60_000);
});
