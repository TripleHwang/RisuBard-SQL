// @vitest-environment node
/**
 * A chat's own settings must survive a refresh.
 *
 * The user reported that per-chat model mode, model, sub-model, preset binding,
 * prompt binding and persona binding all reverted on the first reload while the
 * chat's NAME survived. That split is the diagnosis: `name`, `note`, `folderId`
 * and `lastDate` are columns on the `chats` table and the bootstrap's
 * `summaryChat()` returns exactly those. Everything else on the `Chat` shape --
 * `localLore`, `fmIndex`, `bindedPersona`, `bindedBotPreset`, `useModelPreset`,
 * `modelBinding`, `hypaV3Data`, `scriptstate`, the bookmarks, the per-chat
 * variables -- lives in `chat_extension_nodes`, was written on every commit, and
 * was read back by nothing at all. `relationalSql.loadChat` existed and was
 * exported; no HTTP route served it, `nodeSqliteStorage.loadChat` dug the chat
 * out of the bootstrap instead of asking the server, and `ensureChatHydrated`
 * loaded only the message page.
 *
 * And it was worse than "not read": because the in-memory chat never held those
 * fields, `sqlChatData()` serialised a chat without them and `replaceNodes`
 * DELETEs a chat's whole node set before inserting what it is given. The next
 * flush that touched the chat destroyed the stored settings.
 *
 * Everything below the HTTP boundary is real: a spawned server, a real SQLite
 * file, the real storage object. The node environment and the explicit
 * `proxy()` call are for the reasons `sqlProxyPersistenceLive.test.ts` spells
 * out -- happy-dom's `fetch` cannot reach `127.0.0.1`, and under the server
 * transform `$state` compiles to a plain assignment and creates no proxy, which
 * is exactly the condition under which a write-through bug is invisible.
 */
import { flushSync } from "svelte";
import { proxy } from "svelte/internal/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Chat, Database, character } from "../database.svelte";

const nodeGlobal = globalThis as Record<string, unknown>;
nodeGlobal.window ??= { matchMedia: () => ({ matches: false }), addEventListener: () => {} };
nodeGlobal.document ??= { referrer: "" };
nodeGlobal.navigator ??= {};

const { publishLiveDatabase, resetLiveDatabaseForTesting } = await import("./liveDatabase");
const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { openExistingStandaloneSql, setActiveSqlStorageForTesting } = await import("./sqlBootstrap");
const { ensureChatDetailsHydrated, ensureChatMessageWindow } = await import("./sqlRuntimeHydration");
const { getSqlPosition, getSqlWindow } = await import("./sqlRuntimeWindow");
const {
  flushSqlDirtyChanges,
  markSqlChatDirty,
  resetSqlPersistenceRuntimeForTesting,
} = await import("./sqlPersistenceRuntime");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

const CHARACTER_ID = "character-chat-detail";
const CHAT_ID = "chat-chat-detail";
/**
 * A second chat, used only by the refusal-retention case.
 *
 * Its own chat so that the flush it performs cannot disturb the fields the
 * other cases assert against, and so a failure names which behaviour broke.
 */
const RETAINED_CHAT_ID = "chat-chat-detail-retained";
const HISTORY = 12;

let server: ServerHandle;

/**
 * The settings the user set on this chat. Every one of them lives in
 * `chat_extension_nodes` and none of them is a column on `chats`.
 */
const STORED_CHAT_SETTINGS = {
  bindedPersona: "persona-the-user-picked",
  bindedBotPreset: "preset-the-user-picked",
  useModelPreset: true,
  usePromptPresetParams: true,
  modelBinding: { main: "model-main", sub: "model-sub" },
  fmIndex: 2,
  firstMessageDisabled: true,
  supaMemory: true,
  modules: ["module-one"],
  scriptstate: { counter: 7 },
  bookmarks: ["bookmark-one"],
  bookmarkNames: { "bookmark-one": "the good bit" },
  useLocallySetGlobalVariables: true,
  GLGlobalVariables: { mood: "curious" },
  savedToggleValues: { spoilers: "off" },
  suggestMessages: ["say something"],
  localLore: [{
    key: "per-chat-lore-key",
    comment: "the per-chat lorebook entry",
    content: "only this chat knows this",
    mode: "normal",
    insertorder: 0,
    alwaysActive: false,
    secondkey: "",
    selective: false,
  }],
} as const;

function legacyDatabase(): Database {
  return {
    apiType: "openai",
    username: "name at boot",
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
      alternateGreetings: ["second greeting", "third greeting"],
      chatPage: 0,
      chats: [{
        id: CHAT_ID,
        name: "Chat 0",
        note: "the chat note",
        ...structuredClone(STORED_CHAT_SETTINGS),
        message: Array.from({ length: HISTORY }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: `message ${index}`,
          chatId: `${CHAT_ID}-msg-${String(index).padStart(3, "0")}`,
        })),
      }, {
        id: RETAINED_CHAT_ID,
        name: "Retained chat",
        note: "",
        ...structuredClone(STORED_CHAT_SETTINGS),
        message: [
          { role: "user", data: "only message", chatId: `${RETAINED_CHAT_ID}-msg-000` },
        ],
      }],
    }],
  } as unknown as Database;
}

/**
 * A fresh storage, i.e. what a browser refresh produces: a new bootstrap, and
 * therefore chats that are summaries again.
 *
 * The HTTP client is shared. It only holds the session token, and the server
 * rate-limits logins hard enough that a login per storage exhausts the bucket
 * partway through the suite. What has to be fresh is the `NodeSqliteStorage`
 * and the bootstrap it performs, and both are.
 */
let sharedClient: Awaited<ReturnType<typeof createClient>> | null = null;
async function freshStorage(): Promise<InstanceType<typeof NodeSqliteStorage>> {
  sharedClient ??= await createClient(server.port, server.password);
  const client = sharedClient;
  const storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
  expect(await storage.init()).toBe(true);
  return storage;
}

/** Boot the app the way `bootstrap.ts` does: activate, then wrap in `$state`. */
async function boot(): Promise<{ holder: { db: Database }; character: character }> {
  // Each case is its own refresh: a new storage, a new bootstrap, a new live
  // graph, and no dirty marks carried over from the previous one.
  resetSqlPersistenceRuntimeForTesting();
  const storage = await freshStorage();
  const holder = { db: {} as Database };
  publishLiveDatabase(() => holder.db);
  const opened = await openExistingStandaloneSql(storage);
  expect(opened?.usingSql).toBe(true);
  holder.db = proxy(opened!.database);
  // The fixture is only a faithful stand-in for `DBState.db` if it does NOT
  // write through to the object persistence was activated with.
  expect(holder.db).not.toBe(opened!.database);
  return { holder, character: holder.db.characters[0] as unknown as character };
}

/** What the server actually holds for this chat right now. */
async function storedChat(chatId: string = CHAT_ID): Promise<Record<string, unknown>> {
  const storage = await freshStorage();
  const chat = await storage.loadChatHydration(chatId);
  return (chat ?? {}) as unknown as Record<string, unknown>;
}

describe("a chat's own settings, end to end", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const storage = await freshStorage();
    expect(await storage.replaceDatabase(legacyDatabase())).toBe(true);
  }, 60_000);

  afterAll(async () => {
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetLiveDatabaseForTesting();
    await server?.cleanup();
  });

  it("comes back on the next boot instead of only its name", async () => {
    const { character } = await boot();

    // The precondition, asserted rather than assumed: the bootstrap gives a
    // summary. The name survives because it is a column; nothing else is here.
    const summary = character.chats[0] as Chat & { detailsLoaded?: boolean };
    expect(summary.name).toBe("Chat 0");
    expect(summary.detailsLoaded).toBe(false);
    expect(summary.bindedPersona).toBeUndefined();
    expect(summary.localLore).toBeUndefined();
    expect(summary.fmIndex).toBeUndefined();

    const hydrated = await ensureChatDetailsHydrated(character.chats, 0, CHARACTER_ID);
    flushSync();

    // The live slot, not the object the fetch produced. A caller handed a
    // detached object writes into something the application will never read.
    expect(hydrated).toBe(character.chats[0]);

    // Reported as one object so a failure names the whole loss rather than
    // stopping at whichever field is checked first.
    expect({
      bindedPersona: hydrated!.bindedPersona,
      bindedBotPreset: hydrated!.bindedBotPreset,
      useModelPreset: hydrated!.useModelPreset,
      usePromptPresetParams: hydrated!.usePromptPresetParams,
      modelBinding: hydrated!.modelBinding,
      fmIndex: hydrated!.fmIndex,
      firstMessageDisabled: hydrated!.firstMessageDisabled,
      supaMemory: hydrated!.supaMemory,
      modules: hydrated!.modules,
      scriptstate: hydrated!.scriptstate,
      bookmarks: hydrated!.bookmarks,
      bookmarkNames: hydrated!.bookmarkNames,
      useLocallySetGlobalVariables: hydrated!.useLocallySetGlobalVariables,
      GLGlobalVariables: hydrated!.GLGlobalVariables,
      savedToggleValues: hydrated!.savedToggleValues,
      suggestMessages: hydrated!.suggestMessages,
      localLoreKey: hydrated!.localLore?.[0]?.key,
      localLoreContent: hydrated!.localLore?.[0]?.content,
      detailsLoaded: (hydrated as Chat & { detailsLoaded?: boolean }).detailsLoaded,
    }).toEqual({
      bindedPersona: "persona-the-user-picked",
      bindedBotPreset: "preset-the-user-picked",
      useModelPreset: true,
      usePromptPresetParams: true,
      modelBinding: { main: "model-main", sub: "model-sub" },
      fmIndex: 2,
      firstMessageDisabled: true,
      supaMemory: true,
      modules: ["module-one"],
      scriptstate: { counter: 7 },
      bookmarks: ["bookmark-one"],
      bookmarkNames: { "bookmark-one": "the good bit" },
      useLocallySetGlobalVariables: true,
      GLGlobalVariables: { mood: "curious" },
      savedToggleValues: { spoilers: "off" },
      suggestMessages: ["say something"],
      localLoreKey: "per-chat-lore-key",
      localLoreContent: "only this chat knows this",
      detailsLoaded: true,
    });

    // The detail response carries `message: []`. It must not have landed.
    expect(hydrated!.message).toEqual([]);
  }, 60_000);

  it("leaves the resident message window and its canonical positions alone", async () => {
    const { character } = await boot();

    await ensureChatMessageWindow(character, 0, 8);
    flushSync();
    const beforeChat = character.chats[0];
    const windowBefore = getSqlWindow(beforeChat);
    const positionsBefore = beforeChat.message.map((message) => getSqlPosition(message));
    expect(beforeChat.message).toHaveLength(8);
    expect(windowBefore?.total).toBe(HISTORY);
    expect(positionsBefore).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);

    await ensureChatDetailsHydrated(character.chats, 0, CHARACTER_ID);
    flushSync();

    const afterChat = character.chats[0];
    expect({
      resident: afterChat.message.map((message) => String(message.data)),
      positions: afterChat.message.map((message) => getSqlPosition(message)),
      window: getSqlWindow(afterChat),
      bindedPersona: afterChat.bindedPersona,
    }).toEqual({
      resident: Array.from({ length: 8 }, (_, index) => `message ${index + 4}`),
      positions: [4, 5, 6, 7, 8, 9, 10, 11],
      window: windowBefore,
      bindedPersona: "persona-the-user-picked",
    });
  }, 60_000);

  it("does not write a chat that is still a summary, and the settings survive the flush", async () => {
    const { character } = await boot();
    const summary = character.chats[0] as Chat & { detailsLoaded?: boolean };
    expect(summary.detailsLoaded).toBe(false);

    // Exactly what the idle compatibility audit does when anything about the
    // character looks changed: mark the chat dirty without anyone opening it.
    markSqlChatDirty(CHARACTER_ID, CHAT_ID);
    await flushSqlDirtyChanges();

    const stored = await storedChat();
    expect({
      bindedPersona: stored.bindedPersona,
      fmIndex: stored.fmIndex,
      localLoreKey: (stored.localLore as Array<{ key?: string }> | undefined)?.[0]?.key,
      modelBinding: stored.modelBinding,
    }).toEqual({
      bindedPersona: "persona-the-user-picked",
      fmIndex: 2,
      localLoreKey: "per-chat-lore-key",
      modelBinding: { main: "model-main", sub: "model-sub" },
    });
  }, 60_000);

  it("writes the whole record once the chat has been hydrated", async () => {
    const { character } = await boot();
    await ensureChatDetailsHydrated(character.chats, 0, CHARACTER_ID);
    await ensureChatMessageWindow(character, 0, 40);
    flushSync();

    const live = character.chats[0];
    live.bindedPersona = "persona-the-user-picked-later";
    live.name = "Chat 0 renamed";
    markSqlChatDirty(CHARACTER_ID, CHAT_ID);
    await flushSqlDirtyChanges();

    const stored = await storedChat();
    expect({
      name: stored.name,
      bindedPersona: stored.bindedPersona,
      fmIndex: stored.fmIndex,
      localLoreKey: (stored.localLore as Array<{ key?: string }> | undefined)?.[0]?.key,
    }).toEqual({
      name: "Chat 0 renamed",
      bindedPersona: "persona-the-user-picked-later",
      // The edit did not cost the fields the user did not touch.
      fmIndex: 2,
      localLoreKey: "per-chat-lore-key",
    });
  }, 60_000);

  /**
   * The chat summaries hanging off a hydrated character must not claim to be
   * loaded.
   *
   * `loadCharacter` reads `character_extension_nodes` and never touches
   * `chat_extension_nodes`, so the chats it returns are summaries -- and it used
   * to stamp `detailsLoaded: true` on them. That is a second, independent lie of
   * the same family as the missing read, and it defeats the commit guard
   * outright: every chat of any character the user had opened would be waved
   * through and written back as a stub, whether or not the chat itself was ever
   * opened.
   */
  it("hands back the character's chats as summaries, not as loaded records", async () => {
    const storage = await freshStorage();
    const full = await storage.loadCharacterHydration(CHARACTER_ID);

    const chats = (full?.chats ?? []) as Array<Chat & { detailsLoaded?: boolean }>;
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.map((chat) => chat.detailsLoaded)).toEqual(chats.map(() => false));
    // And they really are summaries: the character route carries none of this.
    expect(chats.map((chat) => chat.localLore)).toEqual(chats.map(() => undefined));
    expect(chats.map((chat) => chat.bindedPersona)).toEqual(chats.map(() => undefined));
  }, 60_000);

  /**
   * `storage.loadChat` must ask the server.
   *
   * It used to iterate `this.current()` -- `loadDatabase({ shallow: true })`,
   * i.e. the bootstrap, i.e. summaries -- and so returned the four columns and
   * never made a request at all. `rebaseDirtyScopes` is its caller, and a rebase
   * that reads a summary is a rebase that learns nothing.
   */
  it("reads one chat from the server rather than out of the bootstrap", async () => {
    const storage = await freshStorage();
    // The retained chat, not the one the previous case edited: this asserts what
    // storage holds, so it must read a chat no earlier case has written to.
    const chat = await storage.loadChat(RETAINED_CHAT_ID, { messageLimit: 1 });

    expect({
      bindedPersona: chat?.bindedPersona,
      fmIndex: chat?.fmIndex,
      localLoreKey: chat?.localLore?.[0]?.key,
      residentMessages: chat?.message.length,
    }).toEqual({
      bindedPersona: "persona-the-user-picked",
      fmIndex: 2,
      localLoreKey: "per-chat-lore-key",
      residentMessages: 1,
    });
    expect(await storage.loadChat("no-such-chat")).toBeNull();
  }, 60_000);

  /**
   * A refusal must defer the write, not discard the edit.
   *
   * `ChatList.svelte` binds `chats[i].name` directly, so a chat the user never
   * opened can be renamed from the list. That marks a summary dirty, and the
   * guard refuses it -- correctly, because writing it would delete the stored
   * settings. If the refusal ended there the rename would be silently eaten:
   * `acknowledge` clears the mark on the way out. So the commit re-marks the
   * chat and goes and loads its fields, and the next flush writes the whole
   * record -- the rename AND the settings.
   */
  it("keeps a rename made on an unopened chat and writes it once the chat loads", async () => {
    const { character } = await boot();
    const index = character.chats.findIndex((chat) => chat.id === RETAINED_CHAT_ID);
    const slot = character.chats[index] as Chat & { detailsLoaded?: boolean };
    expect(slot.detailsLoaded).toBe(false);

    // The rename, exactly as the chat list makes it: on a summary.
    character.chats[index].name = "Renamed from the list";
    markSqlChatDirty(CHARACTER_ID, RETAINED_CHAT_ID);
    await flushSqlDirtyChanges();

    // Refused, so nothing was written and the stored settings are intact.
    expect((await storedChat(RETAINED_CHAT_ID)).name).toBe("Retained chat");

    // The refusal path hydrates the chat in the background. Wait for the mark
    // to become writable rather than assuming a fixed number of ticks.
    const deadline = Date.now() + 20_000;
    while ((character.chats[index] as Chat & { detailsLoaded?: boolean }).detailsLoaded !== true) {
      if (Date.now() > deadline) throw new Error("refused chat was never hydrated");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    flushSync();

    // The rename survived the refusal: it is still on the live slot, and the
    // hydration did not overwrite it with the stored name.
    expect(character.chats[index].name).toBe("Renamed from the list");

    // And the mark survived too, so the next flush writes the whole record.
    await flushSqlDirtyChanges();
    const stored = await storedChat(RETAINED_CHAT_ID);
    expect({
      name: stored.name,
      bindedPersona: stored.bindedPersona,
      fmIndex: stored.fmIndex,
      localLoreKey: (stored.localLore as Array<{ key?: string }> | undefined)?.[0]?.key,
    }).toEqual({
      name: "Renamed from the list",
      bindedPersona: "persona-the-user-picked",
      fmIndex: 2,
      localLoreKey: "per-chat-lore-key",
    });
  }, 60_000);
});
