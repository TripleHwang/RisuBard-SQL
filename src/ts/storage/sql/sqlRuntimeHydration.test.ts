import { beforeEach, describe, expect, it, vi } from "vitest";

const activeStorage = { current: null as any };

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

import {
  ensureCharacterHydrated,
  ensureChatMessageWindow,
  loadOlderChatMessages,
} from "./sqlRuntimeHydration";

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
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m1" }, { chatId: "m2" }], before: null, nextBefore: 2, total: 3, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }, { chatId: "m1" }], before: 2, nextBefore: null, total: 3, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 40);
    await loadOlderChatMessages(character, 0, 40);

    expect(reverse).toHaveBeenNthCalledWith(1, "chat-1", undefined, 40);
    expect(reverse).toHaveBeenNthCalledWith(2, "chat-1", 2, 40);
    expect(character.chats[0].message.map((message: any) => message.chatId)).toEqual(["m0", "m1", "m2"]);
    expect((character.chats[0] as any)._sqlWindow).toMatchObject({ hasOlder: false, total: 3 });
    expect(Object.keys(character.chats[0])).not.toContain("_sqlWindow");
  });

  it("attaches canonical SQL positions to the tail and prepended older page", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m3" }, { chatId: "m4" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 5, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m1" }, { chatId: "m2" }], positions: [1, 4], nextPosition: 13, before: 8, nextBefore: 1, total: 5, hasMore: true });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = { chaId: "character-1", chats: [{ id: "chat-1", message: [] }] } as any;

    await ensureChatMessageWindow(character, 0, 2);
    expect(character.chats[0].message.map((message: any) => message._sqlPosition)).toEqual([8, 12]);
    await loadOlderChatMessages(character, 0, 2);
    expect(character.chats[0].message.map((message: any) => message._sqlPosition)).toEqual([1, 4, 8, 12]);
    expect((character.chats[0] as any)._sqlWindow.nextPosition).toBe(13);
    expect(Object.keys(character.chats[0].message[0])).not.toContain("_sqlPosition");
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
