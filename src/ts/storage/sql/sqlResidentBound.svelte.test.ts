import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Chat, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const {
  ensureChatMessageWindow,
  loadNewestChatMessages,
  loadOlderChatMessages,
  MAX_RESIDENT_MESSAGES,
  RESIDENT_RELEASE_TARGET,
} = await import("./sqlRuntimeHydration");
const { hasNewerSqlMessages, hasOlderSqlMessages, isSqlWindowPartial, getSqlWindow } =
  await import("./sqlRuntimeWindow");
const { isChatHistoryIncomplete } = await import("../chatStorage");
const {
  publishMountedMessageIds,
  releaseMountedMessageIds,
  resetMountedMessageRegistryForTesting,
} = await import("../../chatMountRegistry");
const {
  activateSqlPersistenceRuntime,
  auditSqlCompatibilityDatabase,
  flushSqlDirtyChanges,
  initializeSqlCompatibilityBaseline,
  markSqlMessageDirty,
  resetSqlPersistenceRuntimeForTesting,
} = await import("./sqlPersistenceRuntime");

/**
 * A history that only exists in "storage", served one reverse page at a time --
 * the same shape and the same boundary contract the node backend serves. Pages
 * carry fresh message objects, as a transport would, so nothing in the test can
 * accidentally share identity with what is resident.
 */
const PAGE = 40;

function buildHistory(count: number): Array<{ chatId: string; role: string; data: string }> {
  return Array.from({ length: count }, (_, position) => ({
    chatId: `m-${position}`,
    role: position % 2 === 0 ? "user" : "char",
    data: `message ${position}`,
  }));
}

function reversePageBackend(history: ReturnType<typeof buildHistory>) {
  return vi.fn(async (chatId: string, before: number | undefined, limit: number) => {
    const end = before === undefined ? history.length : before;
    const start = Math.max(0, end - limit);
    const slice = history.slice(start, end);
    return {
      revision: 1,
      chatId,
      messages: slice.map((message) => ({ ...message })),
      positions: slice.map((_, index) => start + index),
      nextPosition: history.length,
      before: before ?? null,
      nextBefore: start > 0 ? start : null,
      total: history.length,
      hasMore: start > 0,
    };
  });
}

function serveHistory(history: ReturnType<typeof buildHistory>) {
  const loadChatMessageReversePage = reversePageBackend(history);
  activeStorage.current = {
    backendKind: "server-sql",
    loadCharacterHydration: vi.fn(),
    loadChatMessageReversePage,
  };
  return loadChatMessageReversePage;
}

/**
 * The chat is held exactly the way the app holds it: a Svelte 5 `$state` proxy
 * reached through `db.characters`. Plain-object fixtures are how the proxy
 * failure shipped green once already, so this file is `.svelte.test.ts` and the
 * proxy-ness is proven below rather than assumed.
 */
let chatSequence = 0;

/**
 * A fresh chat id per test. The dirty registry is module state keyed by chat
 * id, so a mark left behind by one test would silently hold the next test's
 * messages resident and make it pass for the wrong reason.
 */
function nextChatId(): string {
  chatSequence += 1;
  return `chat-${chatSequence}`;
}

function reactiveCharacter(chatId: string): character {
  const state = $state({
    chaId: "character-1",
    chatPage: 0,
    chats: [{
      id: chatId,
      name: "chat",
      note: "",
      localLore: [],
      message: [] as any[],
      _placeholder: true,
      messagesLoaded: false,
    }],
  });
  return state as unknown as character;
}

/** Walk backwards until storage says there is nothing older, recording residency. */
async function pageBackToStart(character: character): Promise<number[]> {
  const residency: number[] = [];
  let guard = 0;
  while (hasOlderSqlMessages(character.chats[0])) {
    await loadOlderChatMessages(character, 0, PAGE);
    residency.push(character.chats[0].message.length);
    if ((guard += 1) > 200) throw new Error("paging did not terminate");
  }
  return residency;
}

beforeEach(() => {
  activeStorage.current = null;
  resetMountedMessageRegistryForTesting();
});

afterEach(() => {
  resetMountedMessageRegistryForTesting();
  resetSqlPersistenceRuntimeForTesting();
});

describe("the fixture really is what the app holds", () => {
  /**
   * The property this whole file leans on: these chats are `$state` proxies, so
   * a symbol-keyed window written on one is both accepted (a plain object would
   * accept it too) and *reactive* (a plain object would not be). The template
   * gate that offers the way back to the newest messages is a `disabled={...}`,
   * which is exactly this effect.
   */
  test("a window written during trimming is visible to a template gate", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    await ensureChatMessageWindow(character, 0, PAGE);
    const chat = character.chats[0];
    const seen: boolean[] = [];

    const stop = $effect.root(() => {
      $effect(() => { seen.push(hasNewerSqlMessages(chat)); });
    });
    try {
      flushSync();
      expect(seen).toEqual([false]);
      await pageBackToStart(character);
      flushSync();
      // The trim happened, and the gate saw it without anyone telling it to.
      expect(seen.at(-1)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe("residency is bounded while paging back through a long history", () => {
  test("a thousand-message history never keeps more than the bound resident", async () => {
    const history = buildHistory(1_000);
    const backend = serveHistory(history);
    const character = reactiveCharacter(nextChatId());

    await ensureChatMessageWindow(character, 0, PAGE);
    const residency = await pageBackToStart(character);

    // The walk really did traverse the whole history rather than stopping early:
    // every page was fetched, and the oldest message is the one resident now.
    expect(backend).toHaveBeenCalledTimes(1_000 / PAGE);
    expect(character.chats[0].message[0].chatId).toBe("m-0");
    expect(hasOlderSqlMessages(character.chats[0])).toBe(false);

    // The point of the task: residency after every single page load, not just
    // at the end. Before the bound existed this series climbed to 1000.
    expect(Math.max(...residency)).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    expect(character.chats[0].message.length).toBeLessThanOrEqual(MAX_RESIDENT_MESSAGES);
    // ...and it is a real bound, not "we never got there": the run did exceed
    // the release target, which is what proves the trimmer actually ran.
    expect(Math.max(...residency)).toBeGreaterThan(RESIDENT_RELEASE_TARGET);
  });

  test("released messages are gone by identity, not merely counted out", async () => {
    const history = buildHistory(1_000);
    serveHistory(history);
    const character = reactiveCharacter(nextChatId());

    await ensureChatMessageWindow(character, 0, PAGE);
    const newest = character.chats[0].message.map((message) => message.chatId);
    await pageBackToStart(character);

    const resident = new Set(character.chats[0].message.map((message) => message.chatId));
    // The newest page is what the trimmer releases first; none of it is still
    // reachable from the chat, so nothing holds those objects alive through it.
    for (const id of newest) expect(resident.has(id)).toBe(false);
  });

  test("the message array is spliced, never replaced", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());

    await ensureChatMessageWindow(character, 0, PAGE);
    const array = character.chats[0].message;
    await pageBackToStart(character);

    // Chats.svelte sweeps mounted rows by identity against this array; a
    // replacement unmounts the whole conversation and blanks the screen.
    expect(character.chats[0].message).toBe(array);
  });
});

describe("releasing is not deleting", () => {
  test("a trimmed chat reports itself partial to every completeness reader", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());

    await ensureChatMessageWindow(character, 0, PAGE);
    await pageBackToStart(character);
    const chat = character.chats[0];

    // Storage holds nothing older -- the walk reached m-0 -- so the reader that
    // only knows about the older direction now says "complete".
    expect(hasOlderSqlMessages(chat)).toBe(false);
    // These are what export, merge, backup, the dirty-commit manifest and the
    // idle audit consult. Every one of them must still see a partial history.
    expect(hasNewerSqlMessages(chat)).toBe(true);
    expect(isSqlWindowPartial(chat)).toBe(true);
    expect((chat as any).messagesFullyLoaded).toBe(false);
    expect(isChatHistoryIncomplete(chat)).toBe(true);
    // And the window says where the resident slice now ends, so the released
    // end can be found again.
    expect(getSqlWindow(chat)!.nextAfter).toBe(
      Number((chat.message.at(-1) as any).chatId.slice(2)),
    );
  });

  test("the newest end can be restored, and the chat is whole again", async () => {
    const history = buildHistory(1_000);
    const backend = serveHistory(history);
    const chatId = nextChatId();
    const character = reactiveCharacter(chatId);

    await ensureChatMessageWindow(character, 0, PAGE);
    await pageBackToStart(character);
    const array = character.chats[0].message;

    await loadNewestChatMessages(character, 0, PAGE);
    const chat = character.chats[0];

    expect(backend).toHaveBeenLastCalledWith(chatId, undefined, PAGE);
    expect(chat.message.map((message) => message.chatId)).toEqual(
      history.slice(-PAGE).map((message) => message.chatId),
    );
    // Spliced back, not rebuilt.
    expect(chat.message).toBe(array);
    // A chat restored to its newest page is indistinguishable from a freshly
    // opened one: newest end resident, older history still out there.
    expect(hasNewerSqlMessages(chat)).toBe(false);
    expect(hasOlderSqlMessages(chat)).toBe(true);
    expect(isSqlWindowPartial(chat)).toBe(true);
    expect(getSqlWindow(chat)!.nextAfter).toBeNull();
  });

  test("restoring is a no-op when nothing was ever released", async () => {
    const backend = serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    await ensureChatMessageWindow(character, 0, PAGE);

    await loadNewestChatMessages(character, 0, PAGE);

    // One call: the initial hydration. Nothing refetched, nothing released.
    expect(backend).toHaveBeenCalledTimes(1);
    expect(character.chats[0].message).toHaveLength(PAGE);
  });
});

describe("what the trimmer refuses to release", () => {
  test("a mounted row is never released, even over the bound", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    await ensureChatMessageWindow(character, 0, PAGE);
    // The screen is drawn from what Chats.svelte has mounted. Pin the newest
    // page -- the first thing the trimmer would otherwise take.
    const mounted = character.chats[0].message.map((message) => message.chatId!);
    const screen = {};
    publishMountedMessageIds(screen, mounted);

    try {
      await pageBackToStart(character);
      const resident = new Set(character.chats[0].message.map((message) => message.chatId));
      for (const id of mounted) {
        expect(resident.has(id), `mounted row ${id} was released and left a hole`).toBe(true);
      }
      // Nothing was released at all: the trimmer stops at the first row it may
      // not take rather than reaching past it.
      expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
      expect(character.chats[0].message).toHaveLength(1_000);
    } finally {
      releaseMountedMessageIds(screen);
    }
  });

  test("a message with an unflushed edit is never released", async () => {
    serveHistory(buildHistory(1_000));
    const chatId = nextChatId();
    const character = reactiveCharacter(chatId);
    await ensureChatMessageWindow(character, 0, PAGE);
    // The user edits the oldest row of the newest page and the flush has not
    // landed yet. buildSqlDirtyCommit finds dirty rows by looking them up in
    // chat.message, so releasing this one loses the edit with no error.
    const edited = character.chats[0].message[0].chatId!;
    expect(edited).toBe("m-960");
    markSqlMessageDirty(chatId, edited);

    await pageBackToStart(character);

    const resident = character.chats[0].message.map((message) => message.chatId);
    expect(resident).toContain(edited);
    // The walk runs newest-first and stops at the first row it may not take, so
    // only the 39 rows newer than the dirty one were released and everything
    // from the dirty row back to the start of history is still here -- well
    // over the bound, which the trimmer gives up rather than drop an edit.
    expect(resident.at(-1)).toBe(edited);
    expect(character.chats[0].message).toHaveLength(961);
    expect(character.chats[0].message.length).toBeGreaterThan(MAX_RESIDENT_MESSAGES);
  });

  test("a streaming chat is left alone", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    await ensureChatMessageWindow(character, 0, PAGE);
    (character.chats[0] as Chat).isStreaming = true;

    await pageBackToStart(character);

    expect(character.chats[0].message).toHaveLength(1_000);
    expect(hasNewerSqlMessages(character.chats[0])).toBe(false);
  });

  test("restoring the newest page refuses to release an unflushed edit", async () => {
    serveHistory(buildHistory(1_000));
    const chatId = nextChatId();
    const character = reactiveCharacter(chatId);
    await ensureChatMessageWindow(character, 0, PAGE);
    await pageBackToStart(character);
    const chat = character.chats[0];
    const before = chat.message.map((message) => message.chatId);

    // Dirtied after the trim, and the flush cannot clear it because no SQL
    // runtime is active to commit it -- so it is still dirty when the restore
    // checks. It must refuse rather than drop the edit.
    const edited = chat.message[0].chatId!;
    markSqlMessageDirty(chatId, edited);
    await flushSqlDirtyChanges();

    await expect(loadNewestChatMessages(character, 0, PAGE)).rejects.toThrow(/unflushed change/);
    // The chat is exactly as the user left it.
    expect(chat.message.map((message) => message.chatId)).toEqual(before);
    expect(hasNewerSqlMessages(chat)).toBe(true);
  });

  test("a refused restore can be retried rather than stranded", async () => {
    const backend = serveHistory(buildHistory(1_000));
    const chatId = nextChatId();
    const character = reactiveCharacter(chatId);
    await ensureChatMessageWindow(character, 0, PAGE);
    await pageBackToStart(character);
    markSqlMessageDirty(chatId, character.chats[0].message[0].chatId!);

    await expect(loadNewestChatMessages(character, 0, PAGE)).rejects.toThrow(/unflushed change/);
    const afterFirst = backend.mock.calls.length;
    await expect(loadNewestChatMessages(character, 0, PAGE)).rejects.toThrow(/unflushed change/);

    // A second press really re-runs. A rejected promise left behind in the
    // in-flight map would be handed back forever, so one refusal would make the
    // newest messages permanently unreachable for the rest of the session.
    expect(backend.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe("the idle audit never turns a released message into a DELETE", () => {
  /**
   * The failure this guards is the one that already reached a user: the audit
   * read a chat whose messages were not resident as a chat whose every message
   * the user had deleted, and issued a DELETE for each -- against rows still on
   * disk. Residency trimming creates exactly that shape on purpose, so the
   * audit has to keep reading a trimmed slice as partial.
   */
  const commitsOf = (storage: any): string[] =>
    storage.commit.mock.calls.flatMap(([commit]: [any]) =>
      (commit.messageDeletes ?? []).flatMap((entry: any) => entry.ids as string[]));

  function fakeStorage() {
    return { getRevision: vi.fn(() => 3), commit: vi.fn(async () => ({ revision: 4 })) };
  }

  test("paging back through a long history issues no message deletes", async () => {
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    const storage = fakeStorage();
    const database = { characters: [character], botPresets: [], pluginCustomStorage: {} } as any;
    activateSqlPersistenceRuntime(storage as any, database);

    await ensureChatMessageWindow(character, 0, PAGE);
    initializeSqlCompatibilityBaseline(database);
    await pageBackToStart(character);

    auditSqlCompatibilityDatabase(database);
    await flushSqlDirtyChanges();

    expect(commitsOf(storage)).toEqual([]);
  });

  test("and the flag that stops it is the one trimming clears", async () => {
    // The same run, with the trimmed chat lying about being complete. If this
    // produced no deletes either, the test above would prove nothing: it would
    // be passing because the audit never looks, not because trimming told it
    // the truth.
    serveHistory(buildHistory(1_000));
    const character = reactiveCharacter(nextChatId());
    const storage = fakeStorage();
    const database = { characters: [character], botPresets: [], pluginCustomStorage: {} } as any;
    activateSqlPersistenceRuntime(storage as any, database);

    await ensureChatMessageWindow(character, 0, PAGE);
    initializeSqlCompatibilityBaseline(database);
    await pageBackToStart(character);
    (character.chats[0] as any).messagesFullyLoaded = true;

    auditSqlCompatibilityDatabase(database);
    await flushSqlDirtyChanges();

    // Every message the trim released, marked for deletion. This is what the
    // released newest end costs when a completeness flag is wrong.
    expect(commitsOf(storage).length).toBeGreaterThan(0);
  });
});
