import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activeStorage = { current: null as any };

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

import {
  ensureCharacterHydrated,
  ensureChatMessageWindow,
  ensureRootKeyHydrated,
  loadOlderChatMessages,
} from "./sqlRuntimeHydration";
import { getSqlPosition, getSqlWindow, setSqlWindow } from "./sqlRuntimeWindow";
import {
  isRootKeyDeferred,
  markRootKeyDeferred,
  resetDeferredRootKeys,
} from "./deferredRootKeys";

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
    // Runtime-only: the window must not survive any path that leads to storage.
    expect(Object.keys(character.chats[0])).not.toContain("_sqlWindow");
    expect(getSqlWindow(JSON.parse(JSON.stringify(character.chats[0])))).toBeUndefined();
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
    expect(getSqlWindow(character.chats[0])?.nextPosition).toBe(13);
    expect(Object.keys(character.chats[0].message[0])).not.toContain("_sqlPosition");
    expect(getSqlPosition(JSON.parse(JSON.stringify(character.chats[0].message[0])))).toBeUndefined();
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

  it("accepts an older page whose tail is behind the window, because a local append moved it", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    // What sending a message while this page is in the air does: the commit
    // allocates the appended row a position and writes the advanced tail back
    // into the window. The page still reports the tail the server saw. Reading
    // that as corruption threw, so a reply sent during a scroll stranded the
    // rest of the history and put a load failure on screen.
    const window = getSqlWindow(character.chats[0])!;
    setSqlWindow(character.chats[0], { ...window, nextPosition: window.nextPosition + 2 });

    await loadOlderChatMessages(character, 0, 2);

    expect(character.chats[0].message.map((message: any) => message.chatId)).toEqual(["m0", "m1", "m2", "m3"]);
    // The local tail is ahead of the server's, and stays ahead.
    expect(getSqlWindow(character.chats[0])!.nextPosition).toBe(15);
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
});

describe("deferred root key hydration", () => {
  beforeEach(() => {
    activeStorage.current = null;
    resetDeferredRootKeys();
  });

  afterEach(() => {
    resetDeferredRootKeys();
  });

  it("shares one in-flight request, installs the value, then clears the deferred mark", async () => {
    const pending = deferred<unknown>();
    const loadRootKeyHydration = vi.fn(() => pending.promise);
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration };
    markRootKeyDeferred("plugins");
    const db = {} as any;

    const first = ensureRootKeyHydrated(db, "plugins");
    const second = ensureRootKeyHydrated(db, "plugins");
    expect(isRootKeyDeferred("plugins")).toBe(true);
    pending.resolve([{ name: "real" }]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ name: "real" }],
      [{ name: "real" }],
    ]);
    expect(loadRootKeyHydration).toHaveBeenCalledOnce();
    expect(db.plugins).toEqual([{ name: "real" }]);
    expect(isRootKeyDeferred("plugins")).toBe(false);
  });

  it("leaves the key deferred and installs nothing when the load fails", async () => {
    const loadRootKeyHydration = vi.fn(async () => { throw new Error("transport exploded"); });
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration };
    markRootKeyDeferred("plugins");
    const db = {} as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).rejects.toThrow("transport exploded");
    expect(Object.prototype.hasOwnProperty.call(db, "plugins")).toBe(false);
    expect(isRootKeyDeferred("plugins")).toBe(true);
  });

  it("can retry after a failure instead of stranding the rejected request", async () => {
    const loadRootKeyHydration = vi.fn()
      .mockRejectedValueOnce(new Error("transport exploded"))
      .mockResolvedValueOnce([{ name: "real" }]);
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration };
    markRootKeyDeferred("plugins");
    const db = {} as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).rejects.toThrow("transport exploded");
    await expect(ensureRootKeyHydrated(db, "plugins")).resolves.toEqual([{ name: "real" }]);
    expect(loadRootKeyHydration).toHaveBeenCalledTimes(2);
    expect(isRootKeyDeferred("plugins")).toBe(false);
  });

  it("refuses to treat an undefined backend result as an empty value", async () => {
    const loadRootKeyHydration = vi.fn(async () => undefined);
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration };
    markRootKeyDeferred("plugins");
    const db = {} as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).rejects.toThrow(/Keeping it deferred/);
    expect(Object.prototype.hasOwnProperty.call(db, "plugins")).toBe(false);
    expect(isRootKeyDeferred("plugins")).toBe(true);
  });

  it("rejects loudly when no backend can load a deferred key", async () => {
    markRootKeyDeferred("plugins");
    const db = {} as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).rejects.toThrow(/unknown, not empty/);
    expect(isRootKeyDeferred("plugins")).toBe(true);
  });

  it("returns the resident value without a request when the key is not deferred", async () => {
    const loadRootKeyHydration = vi.fn();
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration };
    const db = { plugins: [{ name: "resident" }] } as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).resolves.toEqual([{ name: "resident" }]);
    expect(loadRootKeyHydration).not.toHaveBeenCalled();
  });

  it("installs a legitimately empty array only when the backend actually returns one", async () => {
    activeStorage.current = { backendKind: "server-sql", loadRootKeyHydration: vi.fn(async () => []) };
    markRootKeyDeferred("plugins");
    const db = {} as any;

    await expect(ensureRootKeyHydrated(db, "plugins")).resolves.toEqual([]);
    expect(db.plugins).toEqual([]);
    expect(isRootKeyDeferred("plugins")).toBe(false);
  });
});
