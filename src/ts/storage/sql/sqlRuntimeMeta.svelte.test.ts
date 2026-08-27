// Regression coverage for the Svelte 5 `state_descriptors_fixed` crash.
//
// `DBState.db` (and everything under it, including every Chat/Message) is a
// real Svelte 5 `$state` proxy in production. The old implementation attached
// `_sqlWindow`/`_sqlPosition` via `Object.defineProperty(..., { enumerable:
// false })`; Svelte 5 state proxies reject fixed descriptors and throw
// https://svelte.dev/e/state_descriptors_fixed the moment that runs against a
// real proxy instead of a plain test object — which every *other* test in
// this suite uses, so none of them caught it. These tests build actual
// `$state` proxies (like `deepTouch.svelte.test.ts` does) and drive the real
// hydration / dirty-commit code paths through them.
import { beforeEach, describe, expect, it, vi } from "vitest";

const activeStorage = { current: null as any };

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

import { ensureCharacterHydrated, ensureChatMessageWindow, loadOlderChatMessages } from "./sqlRuntimeHydration";
import { buildSqlDirtyCommit } from "./sqlDirtyCommit";
import { sqlChatData, sqlMessageData } from "./sqlCommit";
import type { DirtySnapshot } from "./dirtyRegistry";
import { getSqlPosition, getSqlWindow, hasSqlRuntimeMeta, setSqlPosition, setSqlWindow } from "./sqlRuntimeMeta";

const cleanDirty = (): DirtySnapshot => ({
  rootKeys: [], characterIds: [], chats: [], messages: [],
  messageManifestChatIds: [], messageDeletes: [], pluginStorageKeys: [], presetIds: [],
});

describe("SQL runtime metadata on a real $state proxy", () => {
  beforeEach(() => {
    activeStorage.current = null;
  });

  it("attaches the initial hydration window to a $state chat proxy without throwing", async () => {
    const reverse = vi.fn().mockResolvedValueOnce({
      chatId: "chat-1", messages: [{ chatId: "m1" }, { chatId: "m2" }], positions: [1, 2],
      nextPosition: 3, before: null, nextBefore: 1, total: 3, hasMore: true,
    });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };

    // A genuine reactive proxy, exactly like `character.chats[i]` under DBState.db.
    const character = $state({ chaId: "character-1", chats: [{ id: "chat-1", message: [] as any[] }] });

    await expect(ensureChatMessageWindow(character as any, 0, 2)).resolves.toBeTruthy();

    const chat = character.chats[0];
    expect(chat.message.map((message: any) => message.chatId)).toEqual(["m1", "m2"]);
    expect(getSqlWindow(chat)).toMatchObject({ hasOlder: true, total: 3, nextBefore: 1 });
    expect(getSqlPosition(chat.message[0])).toBe(1);
    expect(getSqlPosition(chat.message[1])).toBe(2);

    // Never leaks into plain enumeration / serialization of the live proxy.
    expect(Object.keys(chat)).not.toContain("_sqlWindow");
    expect(JSON.stringify(chat)).not.toContain("hasOlder");
    expect(hasSqlRuntimeMeta($state.snapshot(chat))).toBe(false);
  });

  it("prepends an older reverse page onto a $state chat proxy without throwing", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true })
      .mockResolvedValueOnce({ chatId: "chat-1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };

    const character = $state({ chaId: "character-1", chats: [{ id: "chat-1", message: [] as any[] }] });

    await ensureChatMessageWindow(character as any, 0, 2);
    await expect(loadOlderChatMessages(character as any, 0, 2)).resolves.toBeTruthy();

    const chat = character.chats[0];
    expect(chat.message.map((message: any) => [message.chatId, getSqlPosition(message)])).toEqual([
      ["m0", 0], ["m1", 4], ["m2", 8], ["m3", 12],
    ]);
    expect(getSqlWindow(chat)).toMatchObject({ hasOlder: false, total: 4 });
    expect(hasSqlRuntimeMeta($state.snapshot(chat))).toBe(false);
    expect(chat.message.every((message: any) => !hasSqlRuntimeMeta($state.snapshot(message)))).toBe(true);
  });

  it("dirty-commits a newly appended message on a $state chat proxy without throwing", () => {
    const database = $state({
      characters: [{
        chaId: "character-a",
        chats: [{
          id: "chat-a",
          message: [
            { chatId: "m-0", role: "char", data: "old-0" },
            { chatId: "m-1", role: "char", data: "old-1" },
          ] as any[],
        }],
      }],
      botPresets: [] as any[],
      pluginCustomStorage: {} as Record<string, unknown>,
    });

    const chat = database.characters[0].chats[0];
    // The tail is an incomplete SQL-hydrated window: mark it so, and give the
    // two existing messages their canonical positions (as real hydration would).
    (chat as any).messagesFullyLoaded = false;
    setSqlWindow(chat, { hasOlder: true, nextPosition: 5 });
    setSqlPosition(chat.message[0], 3);
    setSqlPosition(chat.message[1], 4);
    chat.message.push({ chatId: "m-new", role: "char", data: "new" });

    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-new"] }];

    let commit: ReturnType<typeof buildSqlDirtyCommit>;
    expect(() => { commit = buildSqlDirtyCommit(database as any, dirty, 7); }).not.toThrow();

    expect(commit!.messages).toEqual([
      expect.objectContaining({ id: "m-new", chatId: "chat-a", position: 5 }),
    ]);
    // allocateAppendedPositions must have attached the canonical position back
    // onto the live proxied message, and advanced the live window in place.
    expect(getSqlPosition(chat.message[2])).toBe(5);
    expect(getSqlWindow(chat)?.nextPosition).toBe(6);

    // The row data handed to persistence never carries the runtime metadata,
    // even though `sqlMessageData`/`sqlChatData` build it via spread from the
    // live (non-snapshotted) proxy — spread is the one path that DOES copy
    // Symbol-keyed properties, so this exercises the real leak risk.
    const messageData = sqlMessageData(chat.message[2] as any);
    expect(hasSqlRuntimeMeta(messageData as object)).toBe(false);
    expect(Object.getOwnPropertySymbols(messageData as object)).toHaveLength(0);
    const chatData = sqlChatData(chat as any);
    expect(hasSqlRuntimeMeta(chatData as object)).toBe(false);
    expect(Object.getOwnPropertySymbols(chatData as object)).toHaveLength(0);
  });

  it("keeps plain-object and $state-proxy chats behaviorally identical for window/position access", () => {
    const plainChat = { id: "chat-1", message: [{ chatId: "m1" }] as any[] };
    const proxyChat = $state({ id: "chat-1", message: [{ chatId: "m1" }] as any[] });

    for (const chat of [plainChat, proxyChat]) {
      expect(getSqlWindow(chat)).toBeUndefined();
      expect(() => setSqlWindow(chat, { hasOlder: true, total: 1 })).not.toThrow();
      expect(getSqlWindow(chat)).toMatchObject({ hasOlder: true, total: 1 });

      expect(getSqlPosition(chat.message[0])).toBeUndefined();
      expect(() => setSqlPosition(chat.message[0], 7)).not.toThrow();
      expect(getSqlPosition(chat.message[0])).toBe(7);

      expect(Object.keys(chat)).not.toContain("_sqlWindow");
      expect(JSON.parse(JSON.stringify(chat))).not.toHaveProperty("_sqlWindow");
      expect(hasSqlRuntimeMeta(structuredClone($state.snapshot(chat)))).toBe(false);
    }
  });

  // The three sites below (nodeSqliteStorage.ts's `_sqlCharacterBodyCollapsed`,
  // and sqlRuntimeHydration.ts's `_sqlHydrationRevision` /
  // `_sqlMetadataOverrides`) were audited during the v0.3.2.8 hotfix and found
  // to be structurally safe: each `Object.defineProperty` call runs on an
  // object that is freshly constructed (JSON-parsed or built via spread) and
  // has not yet been assigned into `DBState.db`, so it is never itself a
  // `$state` proxy — the proxy's `defineProperty` trap (which throws
  // `state_descriptors_fixed` for non-basic descriptors) never runs against
  // these targets. These tests exercise the real, reactive end state of each
  // path — the object *after* it has been folded into a `$state` tree — to
  // prove that verdict rather than merely assert it.

  it("carries a fresh, non-enumerable _sqlCharacterBodyCollapsed flag through ensureCharacterHydrated into a $state db without throwing", async () => {
    // Reproduces exactly what nodeSqliteStorage.ts's loadCharacterHydration
    // does: Object.defineProperty on a freshly-parsed JSON payload, before it
    // is ever seen by DBState. This proves the *shape* of the value flowing
    // into ensureCharacterHydrated (a non-enumerable string-keyed property on
    // a plain object), not just its presence.
    const collapsedPayload = { chaId: "character-1", chats: [] } as any;
    Object.defineProperty(collapsedPayload, "_sqlCharacterBodyCollapsed", {
      configurable: true,
      enumerable: false,
      value: true,
    });
    const repairedPayload = { chaId: "character-1", chats: [], description: "Recovered" } as any;

    const loadCharacterHydration = vi.fn()
      .mockResolvedValueOnce(collapsedPayload)
      .mockResolvedValueOnce(repairedPayload);
    const repairCollapsedCharacter = vi.fn().mockResolvedValueOnce({ status: "repaired", revision: 2 });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration, repairCollapsedCharacter, loadChatMessageReversePage: vi.fn() };

    // A genuine reactive proxy, exactly like `DBState.db` in production.
    const db = $state({
      characters: [{ chaId: "character-1", detailsLoaded: false, chats: [] as any[] }],
      botPresets: [] as any[],
      pluginCustomStorage: {} as Record<string, unknown>,
    });

    await expect(ensureCharacterHydrated(db as any, 0)).resolves.toMatchObject({
      description: "Recovered",
      detailsLoaded: true,
    });
    expect(loadCharacterHydration).toHaveBeenCalledTimes(2);
    expect(repairCollapsedCharacter).toHaveBeenCalledTimes(1);
  });

  it("attaches _sqlHydrationRevision and _sqlMetadataOverrides to a freshly merged chat body inside a $state character tree without throwing", async () => {
    const loadChatHydration = vi.fn().mockResolvedValueOnce({
      revision: 5,
      chat: { id: "chat-1", characterId: "character-1", name: "server body", message: [{ chatId: "m1" }] },
    });
    const loadChatMessageReversePage = vi.fn().mockResolvedValueOnce({
      revision: 5, chatId: "chat-1", messages: [{ chatId: "m1" }], positions: [0],
      nextPosition: 1, before: 0, nextBefore: null, total: 1, hasMore: false,
    });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatHydration, loadChatMessageReversePage };

    // A genuine reactive proxy, exactly like `character.chats[i]` under DBState.db.
    const character = $state({ chaId: "character-1", chats: [{ id: "chat-1", detailsLoaded: false, message: [] as any[] }] });

    await expect(ensureChatMessageWindow(character as any, 0, 2)).resolves.toMatchObject({ name: "server body" });

    // The merged chat replaced character.chats[0] and is now read back through
    // the array's reactive get trap — a real live proxy, not the plain object
    // that Object.defineProperty was originally called on.
    const chat = character.chats[0];
    expect(Object.keys(chat)).not.toContain("_sqlHydrationRevision");
    expect(Object.keys(chat)).not.toContain("_sqlMetadataOverrides");
    expect(JSON.stringify(chat)).not.toContain("_sqlHydrationRevision");
    expect(hasSqlRuntimeMeta($state.snapshot(chat))).toBe(false);
  });
});
