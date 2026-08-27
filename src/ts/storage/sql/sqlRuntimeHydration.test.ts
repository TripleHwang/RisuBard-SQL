import { beforeEach, describe, expect, it, vi } from "vitest";

const activeStorage = { current: null as any };

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

import {
  ensureCharacterHydrated,
  ensureChatHydrated,
  ensureChatMessageWindow,
  loadOlderChatMessages,
  repairUnavailableMessage,
} from "./sqlRuntimeHydration";
import { languageEnglish } from "src/lang/en";
import { languageKorean } from "src/lang/ko";
import { getSqlPosition, getSqlWindow, hasSqlRuntimeMeta } from "./sqlRuntimeMeta";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Node SQL runtime hydration", () => {
  beforeEach(() => {
    activeStorage.current = null;
  });

  it("deduplicates concurrent character hydration and replaces only the matching summary", async () => {
    const full = { chaId: "character-1", detailsLoaded: true, chats: [] } as any;
    const loadCharacterHydration = vi.fn(async () => full);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration, loadChatMessageReversePage: vi.fn() };
    const db = { characters: [{ chaId: "character-1", detailsLoaded: false, chats: [] }] } as any;

    const [first, second] = await Promise.all([
      ensureCharacterHydrated(db, 0),
      ensureCharacterHydrated(db, 0),
    ]);

    expect(loadCharacterHydration).toHaveBeenCalledOnce();
    expect((first as any)?.detailsLoaded).toBe(true);
    expect(second?.chaId).toBe("character-1");
  });

  it("does not replace a summary if the character slot changes while it loads", async () => {
    const pending = deferred<any>();
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(() => pending.promise), loadChatMessageReversePage: vi.fn() };
    const summary = { chaId: "character-1", detailsLoaded: false, chats: [] } as any;
    const another = { chaId: "character-2", detailsLoaded: false, chats: [] } as any;
    const db = { characters: [summary] } as any;

    const result = ensureCharacterHydrated(db, 0);
    db.characters[0] = another;
    pending.resolve({ chaId: "character-1", detailsLoaded: true, chats: [] });

    await expect(result).resolves.toBeNull();
    expect(db.characters[0]).toBe(another);
  });

  it("loads newest 40 then prepends an older reverse page without duplicates", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m1" }, { chatId: "m2" }], positions: [1, 2], nextPosition: 3, before: null, nextBefore: 2, total: 3, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }], positions: [0], nextPosition: 3, before: 2, nextBefore: null, total: 3, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 40);
    await loadOlderChatMessages(character, 0, 40);

    expect(reverse).toHaveBeenNthCalledWith(1, "chat-1", undefined, 40);
    expect(reverse).toHaveBeenNthCalledWith(2, "chat-1", 2, 40);
    expect(character.chats[0].message.map((message: any) => message.chatId)).toEqual(["m0", "m1", "m2"]);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ hasOlder: false, total: 3 });
    expect(Object.keys(character.chats[0])).not.toContain("_sqlWindow");
    expect(hasSqlRuntimeMeta(character.chats[0])).toBe(true);
  });

  it("keeps 81 sequential durable IDs complete through serialized reverse chunks", async () => {
    const rows = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({ chatId: `m${start + index}` }));
    const positions = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => start + index);
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: rows(41, 81), positions: positions(41, 81), nextPosition: 81, before: 81, nextBefore: 41, total: 81, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: rows(1, 41), positions: positions(1, 41), nextPosition: 81, before: 41, nextBefore: 1, total: 81, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: rows(0, 1), positions: positions(0, 1), nextPosition: 81, before: 1, nextBefore: null, total: 81, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 40);
    expect(character.chats[0].message.map((message: any) => message.chatId)).toEqual(rows(41, 81).map((message) => message.chatId));
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 81, hasOlder: true });

    await loadOlderChatMessages(character, 0, 40);
    await loadOlderChatMessages(character, 0, 40);
    const ids = character.chats[0].message.map((message: any) => message.chatId);
    expect(ids).toEqual(rows(0, 81).map((message) => message.chatId));
    expect(new Set(ids)).toHaveLength(81);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 81, hasOlder: false });
  });

  it("attaches canonical SQL positions to the tail and prepended older page", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m3" }, { chatId: "m4" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 5, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m1" }, { chatId: "m2" }], positions: [1, 4], nextPosition: 13, before: 8, nextBefore: 1, total: 5, hasMore: true });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    expect(character.chats[0].message.map((message: any) => getSqlPosition(message))).toEqual([8, 12]);
    await loadOlderChatMessages(character, 0, 2);
    expect(character.chats[0].message.map((message: any) => getSqlPosition(message))).toEqual([1, 4, 8, 12]);
    expect(getSqlWindow(character.chats[0]).nextPosition).toBe(13);
    expect(Object.keys(character.chats[0].message[0])).not.toContain("_sqlPosition");
    expect(hasSqlRuntimeMeta(character.chats[0].message[0])).toBe(true);
  });

  it("keeps page message positions paired when an older page precedes the window", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    await loadOlderChatMessages(character, 0, 3);

    expect(character.chats[0].message.map((message: any) => [message.chatId, getSqlPosition(message)])).toEqual([
      ["m0", 0], ["m1", 4], ["m2", 8], ["m3", 12],
    ]);
  });

  it.each([
    ["changed total", { total: 5 }],
    ["duplicate ID", { messages: [{ chatId: "m2" }], positions: [1] }],
    ["noncontiguous boundary", { before: 7 }],
    ["changed next-before position", { hasMore: true, nextBefore: 2 }],
  ])("rejects an older page with %s without changing the loaded window", async (_name, change) => {
    const newest = { chatId: "chat-1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true };
    const older = { chatId: "chat-1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false, ...change };
    const reverse = vi.fn().mockResolvedValueOnce(newest).mockResolvedValueOnce(older);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    const previousMessages = character.chats[0].message;
    const previousWindow = getSqlWindow(character.chats[0]);
    await expect(loadOlderChatMessages(character, 0, 2)).rejects.toThrow(/reverse page/i);

    expect(character.chats[0].message).toBe(previousMessages);
    expect(getSqlWindow(character.chats[0])).toBe(previousWindow);
  });

  it("rejects a terminal reverse page that leaves known message coverage below total", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }], positions: [0], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    const previousMessages = character.chats[0].message;
    const previousWindow = getSqlWindow(character.chats[0]);
    await expect(loadOlderChatMessages(character, 0, 2)).rejects.toThrow(/reverse page/i);
    expect(character.chats[0].message).toBe(previousMessages);
    expect(getSqlWindow(character.chats[0])).toBe(previousWindow);
  });

  it("deduplicates concurrent initial chat window hydration", async () => {
    const pending = deferred<any>();
    const reverse = vi.fn(() => pending.promise);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    const first = ensureChatMessageWindow(character, 0);
    const second = ensureChatMessageWindow(character, 0);
    pending.resolve({ chatId: "chat-1", messages: [], before: null, nextBefore: null, total: 0, hasMore: false });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(reverse).toHaveBeenCalledOnce();
  });

  it("hydrates a chat body by stable ID before loading its bounded recent message page", async () => {
    const loadChatHydration = vi.fn(async () => ({ revision: 1, chat: { id: "chat-1", characterId: "character-1", name: "Stored", custom: { preserved: true }, message: [], detailsLoaded: true } }));
    const reverse = vi.fn(async () => ({ revision: 1, chatId: "chat-1", messages: [{ chatId: "m1" }], positions: [0], nextPosition: 1, before: null, nextBefore: null, total: 1, hasMore: false }));
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", name: "Summary", detailsLoaded: false, message: [] }] } as any;

    await ensureChatHydrated(character, 0, 40);

    expect(loadChatHydration).toHaveBeenCalledWith("chat-1");
    expect(reverse).toHaveBeenCalledWith("chat-1", undefined, 40);
    expect(character.chats[0]).toMatchObject({ id: "chat-1", custom: { preserved: true }, detailsLoaded: true, message: [{ chatId: "m1" }] });
  });

  it("keeps a summary metadata edit made while chat body hydration is in flight", async () => {
    const pending = deferred<any>();
    const loadChatHydration = vi.fn(() => pending.promise);
    const reverse = vi.fn(async () => ({ revision: 1, chatId: "chat-1", messages: [], positions: [], nextPosition: 0, before: null, nextBefore: null, total: 0, hasMore: false }));
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", name: "Summary", note: "old", folderId: "folder-1", detailsLoaded: false, message: [] }] } as any;

    const hydration = ensureChatHydrated(character, 0, 40);
    character.chats[0].name = "Locally renamed";
    character.chats[0].note = "local note";
    character.chats[0].folderId = "folder-2";
    pending.resolve({ revision: 1, chat: { id: "chat-1", characterId: "character-1", name: "Stored", note: "stored", folderId: "folder-1", custom: { preserved: true }, message: [], detailsLoaded: true } });

    await hydration;

    expect(character.chats[0]).toMatchObject({ name: "Locally renamed", note: "local note", folderId: "folder-2", custom: { preserved: true } });
  });

  it("repairs a collapsed character body once, reloads it once, and rejects an unavailable repair", async () => {
    const loadCharacterHydration = vi.fn()
      .mockResolvedValueOnce({ chaId: "character-1", _sqlCharacterBodyCollapsed: true, chats: [] })
      .mockResolvedValueOnce({ chaId: "character-1", description: "Recovered", chats: [] });
    const repairCollapsedCharacter = vi.fn(async () => ({ status: "repaired", revision: 2 }));
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration, repairCollapsedCharacter, loadChatMessageReversePage: vi.fn() };
    const db = { characters: [{ chaId: "character-1", detailsLoaded: false, chats: [] }] } as any;
    await expect(ensureCharacterHydrated(db, 0)).resolves.toMatchObject({ description: "Recovered", detailsLoaded: true });
    expect(repairCollapsedCharacter).toHaveBeenCalledTimes(1);
    expect(loadCharacterHydration).toHaveBeenCalledTimes(2);

    // An `unavailable` repair rejects with the user-facing message for its
    // reason code. With no reason and no census the server told us nothing we
    // can quote, so this is the unknown-reason wording — and it must still
    // reassure the user that nothing was modified.
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(async () => ({ chaId: "character-1", _sqlCharacterBodyCollapsed: true, chats: [] })), repairCollapsedCharacter: vi.fn(async () => ({ status: "unavailable", revision: 1 })), loadChatMessageReversePage: vi.fn() };
    await expect(ensureCharacterHydrated({ characters: [{ chaId: "character-1", detailsLoaded: false, chats: [] }] } as any, 0)).rejects.toThrow(/could not be recovered/i);

    const concurrentLoad = vi.fn()
      .mockResolvedValueOnce({ chaId: "character-1", _sqlCharacterBodyCollapsed: true, chats: [] })
      .mockResolvedValueOnce({ chaId: "character-1", desc: "Concurrent recovery", chats: [] });
    const concurrentRepair = vi.fn(async () => ({ status: "not-needed", revision: 3 }));
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: concurrentLoad, repairCollapsedCharacter: concurrentRepair, loadChatMessageReversePage: vi.fn() };
    await expect(ensureCharacterHydrated({ characters: [{ chaId: "character-1", detailsLoaded: false, chats: [] }] } as any, 0)).resolves.toMatchObject({ desc: "Concurrent recovery" });
    expect(concurrentRepair).toHaveBeenCalledOnce();
    expect(concurrentLoad).toHaveBeenCalledTimes(2);
  });

  it("uses newer server summary metadata unless that field changed during body loading", async () => {
    const pending = deferred<any>();
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration: vi.fn(() => pending.promise), loadChatMessageReversePage: vi.fn(async () => ({ revision: 1, chatId: "chat", messages: [], positions: [], nextPosition: 0, before: null, nextBefore: null, total: 0, hasMore: false })) };
    const character = { chaId: "char", chats: [{ id: "chat", name: "stale", note: "unchanged", detailsLoaded: false, message: [] }] } as any;
    const hydration = ensureChatHydrated(character, 0);
    character.chats[0].name = "local";
    pending.resolve({ revision: 1, chat: { id: "chat", characterId: "char", name: "server", note: "server-note", message: [] } });
    await hydration;
    expect(character.chats[0]).toMatchObject({ name: "local", note: "server-note" });
  });

  it("rejects a body owned by a different character", async () => {
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration: vi.fn(async () => ({ revision: 1, chat: { id: "chat", characterId: "other", message: [] } })), loadChatMessageReversePage: vi.fn() };
    await expect(ensureChatHydrated({ chaId: "char", chats: [{ id: "chat", detailsLoaded: false, message: [] }] } as any, 0)).rejects.toThrow(/owner mismatch/i);
  });

  it("does not deduplicate distinct slash-containing character and chat IDs", async () => {
    const pending = deferred<any>(); const loadChatHydration = vi.fn(() => pending.promise);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage: vi.fn(async () => ({ revision: 1, chatId: "b/c", messages: [], positions: [], nextPosition: 0, before: null, nextBefore: null, total: 0, hasMore: false })) };
    const first = ensureChatHydrated({ chaId: "a/b", chats: [{ id: "c", detailsLoaded: false, message: [] }] } as any, 0);
    const second = ensureChatHydrated({ chaId: "a", chats: [{ id: "b/c", detailsLoaded: false, message: [] }] } as any, 0);
    expect(loadChatHydration).toHaveBeenCalledTimes(2);
    pending.resolve({ revision: 1, chat: { id: "c", characterId: "a/b", message: [] } });
    await first; await second.catch(() => null);
  });

  it("retries chat hydration when the message page revision changes between reads", async () => {
    const loadChatHydration = vi.fn()
      .mockResolvedValueOnce({ revision: 1, chat: { id: "chat", characterId: "char", name: "old body", message: [] } })
      .mockResolvedValueOnce({ revision: 2, chat: { id: "chat", characterId: "char", name: "new body", message: [] } });
    const loadChatMessageReversePage = vi.fn()
      .mockResolvedValueOnce({ revision: 2, chatId: "chat", messages: [{ chatId: "mixed" }], positions: [0], nextPosition: 1, before: 1, nextBefore: null, total: 1, hasMore: false })
      .mockResolvedValueOnce({ revision: 2, chatId: "chat", messages: [{ chatId: "consistent" }], positions: [0], nextPosition: 1, before: 1, nextBefore: null, total: 1, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage };
    const character = { chaId: "char", chats: [{ id: "chat", detailsLoaded: false, message: [] }] } as any;

    await expect(ensureChatHydrated(character, 0)).resolves.toMatchObject({ name: "new body", message: [{ chatId: "consistent" }] });
    expect(loadChatHydration).toHaveBeenCalledTimes(2);
    expect(loadChatMessageReversePage).toHaveBeenCalledTimes(2);
  });

  it("preserves an in-flight metadata edit across a revision retry", async () => {
    const firstBody = deferred<any>();
    const loadChatHydration = vi.fn()
      .mockImplementationOnce(() => firstBody.promise)
      .mockResolvedValueOnce({ revision: 2, chat: { id: "chat", characterId: "char", name: "server replacement", message: [] } });
    const loadChatMessageReversePage = vi.fn()
      .mockResolvedValueOnce({ revision: 2, chatId: "chat", messages: [], positions: [], nextPosition: 0, before: 0, nextBefore: null, total: 0, hasMore: false })
      .mockResolvedValueOnce({ revision: 2, chatId: "chat", messages: [], positions: [], nextPosition: 0, before: 0, nextBefore: null, total: 0, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage };
    const character = { chaId: "char", chats: [{ id: "chat", name: "stale", detailsLoaded: false, message: [] }] } as any;

    const hydration = ensureChatHydrated(character, 0);
    character.chats[0].name = "local edit";
    firstBody.resolve({ revision: 1, chat: { id: "chat", characterId: "char", name: "local edit", message: [] } });

    await expect(hydration).resolves.toMatchObject({ name: "local edit" });
  });
});

// The whole point of the reason/census contract is that the message the user
// reads never claims more than the server actually examined. These lock that
// down at the exact place the claim is made.
describe("repair unavailable messaging", () => {
  const census = (total: number, examined: number, unreadable: number, skipped: number) =>
    ({ total, examined, unreadable, skipped });

  it("only says the character is in no backup when every backup was examined", () => {
    const message = repairUnavailableMessage({
      status: "unavailable", revision: 1, reason: "absent-from-all", backups: census(4, 4, 0, 0),
    });
    expect(message).toContain("4");
    expect(message).toMatch(/all 4 of your backups were checked/i);
  });

  it("names both the checked and the unchecked counts when coverage was partial", () => {
    // 12 exist, 3 read, 2 unreadable, 7 never opened -> 3 checked, 9 not.
    const message = repairUnavailableMessage({
      status: "unavailable", revision: 1, reason: "absent-from-examined", backups: census(12, 3, 2, 7),
    });
    expect(message).toMatch(/not in the 3 backups that could be read, and 9 could not be checked/i);
    // Must NOT assert absence across everything.
    expect(message).not.toMatch(/all .* backups were checked/i);
    expect(message).not.toMatch(/none contained/i);
  });

  it("says nothing about presence when no backup could be read", () => {
    const message = repairUnavailableMessage({
      status: "unavailable", revision: 1, reason: "all-unreadable", backups: census(5, 0, 5, 0),
    });
    expect(message).toMatch(/none of your 5 backups could be read/i);
    expect(message).not.toMatch(/not (in|found)/i);
  });

  it("distinguishes having no backups at all from having searched them", () => {
    const message = repairUnavailableMessage({ status: "unavailable", revision: 1, reason: "no-backups", backups: census(0, 0, 0, 0) });
    expect(message).toMatch(/no backups/i);
    expect(message).not.toMatch(/could not be read/i);
    // No placeholder to fill, so it works even without a census.
    expect(repairUnavailableMessage({ status: "unavailable", revision: 1, reason: "no-backups" })).toBe(message);
  });

  it("falls back to the unknown-reason wording rather than quoting an unmeasured count", () => {
    for (const reason of ["absent-from-all", "absent-from-examined", "all-unreadable"]) {
      const message = repairUnavailableMessage({ status: "unavailable", revision: 1, reason });
      expect(message).toBe(languageEnglish.sqlCharacterRepairUnavailableUnknown);
      expect(message).not.toContain("{}");
    }
    expect(repairUnavailableMessage({ status: "unavailable", revision: 1, reason: "something-new" }))
      .toBe(languageEnglish.sqlCharacterRepairUnavailableUnknown);
    expect(repairUnavailableMessage({ status: "unavailable", revision: 1 }))
      .toBe(languageEnglish.sqlCharacterRepairUnavailableUnknown);
  });

  it("never leaves an unfilled placeholder in any reason's message", () => {
    for (const reason of ["no-backups", "all-unreadable", "absent-from-examined", "absent-from-all", "bogus"]) {
      const message = repairUnavailableMessage({
        status: "unavailable", revision: 1, reason, backups: census(9, 2, 3, 4),
      });
      expect(message).not.toContain("{}");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("tells the user nothing was changed, so a failed repair reads as recoverable", () => {
    for (const reason of ["no-backups", "all-unreadable", "absent-from-examined", "absent-from-all", "bogus"]) {
      const message = repairUnavailableMessage({
        status: "unavailable", revision: 1, reason, backups: census(9, 2, 3, 4),
      });
      expect(message).toMatch(/nothing was changed/i);
    }
  });

  it("keeps EN and KO placeholder counts identical so neither can drop or invent a number", () => {
    const keys = [
      "sqlCharacterRepairUnavailableNoBackups",
      "sqlCharacterRepairUnavailableAllUnreadable",
      "sqlCharacterRepairUnavailableAbsentFromExamined",
      "sqlCharacterRepairUnavailableAbsentFromAll",
      "sqlCharacterRepairUnavailableUnknown",
    ] as const;
    const expected = { sqlCharacterRepairUnavailableNoBackups: 0, sqlCharacterRepairUnavailableAllUnreadable: 1, sqlCharacterRepairUnavailableAbsentFromExamined: 2, sqlCharacterRepairUnavailableAbsentFromAll: 1, sqlCharacterRepairUnavailableUnknown: 0 } as Record<string, number>;
    for (const key of keys) {
      const en = languageEnglish[key];
      const ko = languageKorean[key];
      expect(typeof en, key).toBe("string");
      expect(typeof ko, key).toBe("string");
      expect((en.match(/\{\}/g) ?? []).length, `EN ${key}`).toBe(expected[key]);
      expect((ko.match(/\{\}/g) ?? []).length, `KO ${key}`).toBe(expected[key]);
    }
  });

  it("retires the old overstating keys so they cannot be reintroduced", () => {
    expect(languageEnglish).not.toHaveProperty("sqlCharacterRepairUnavailableNoCandidate");
    expect(languageEnglish).not.toHaveProperty("sqlCharacterRepairUnavailableDecodeFailed");
    expect(languageKorean).not.toHaveProperty("sqlCharacterRepairUnavailableNoCandidate");
    expect(languageKorean).not.toHaveProperty("sqlCharacterRepairUnavailableDecodeFailed");
  });
});
