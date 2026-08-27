// Regression suite for the chat-switch hydration stall (v0.3.2.10).
//
// Symptom: switching between chats a few times leaves a chat showing only the
// character's first message, with
//   [changeChatTo] hydration failed: Error: SQL chat hydration revision changed
// in the console. Intermittent — "sometimes it loads, sometimes it doesn't".
//
// Cause: the initial window hydration is stitched from TWO server reads (the
// chat body, then the newest reverse message page) and used to require that
// both carry the same `revision`. That revision is `system_storage_meta.revision`
// — one counter for the WHOLE database, bumped by every commit. Any unrelated
// background write (another chat's dirty commit, the 5s compatibility audit,
// a plugin storage write) landing between the two reads therefore aborted the
// hydration of a chat that had not changed at all.
//
// Each case below started life asserting the broken behavior; they now pin the
// fixed behavior.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const activeStorage = { current: null as any };
vi.mock("./sqlBootstrap", () => ({ getActiveSqlStorage: () => activeStorage.current }));

import { ensureChatHydrated, ensureChatMessageWindow } from "./sqlRuntimeHydration";
import { getSqlWindow } from "./sqlRuntimeMeta";
import { isHydrationActive } from "../hydrationState";
import { chatHydrationKey } from "../chatHydrationKey";

/** A message page shaped the way `loadChatMessageReversePage` returns one. */
function page(revision: number, ids: string[], total = ids.length) {
  return {
    revision,
    chatId: "c1",
    messages: ids.map((chatId) => ({ chatId })),
    positions: ids.map((_, index) => index),
    nextPosition: ids.length,
    before: ids.length,
    nextBefore: null,
    total,
    hasMore: false,
  };
}

function body(revision: number, messageTotal: number, name = "chat one") {
  return { revision, chat: { id: "c1", characterId: "ch1", name, message: [], messageTotal, detailsLoaded: true } };
}

describe("chat-switch hydration", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    activeStorage.current = null;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); });

  it("A. an unrelated background commit between the two reads no longer aborts the hydration", async () => {
    // The database-wide revision advances on every read because OTHER work is
    // committing (autosave of a different chat, the compatibility audit, ...).
    // This chat itself is untouched: its message count is 2 in both snapshots.
    let globalRevision = 10;
    const loadChatHydration = vi.fn(async () => body(++globalRevision, 2));
    const loadChatMessageReversePage = vi.fn(async () => page(++globalRevision, ["m1", "m2"]));
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatHydration,
      loadChatMessageReversePage,
    };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", detailsLoaded: false, message: [] as any[] }] });

    await expect(ensureChatHydrated(character as any, 0)).resolves.toBeTruthy();

    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2"]);
    expect((character.chats[0] as any).messagesLoaded).toBe(true);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 2, hasOlder: false });
    // No wasted round trips: the skew is recognized as irrelevant on the first
    // pass rather than driving a re-read that can never converge.
    expect(loadChatHydration).toHaveBeenCalledTimes(1);
    expect(loadChatMessageReversePage).toHaveBeenCalledTimes(1);
  });

  it("B. a real change to THIS chat between the two reads still forces a consistent re-read", async () => {
    // The chat gained a message between the body read and the page read, so the
    // body's `messageTotal` and the page's `total` genuinely disagree.
    const loadChatHydration = vi.fn()
      .mockResolvedValueOnce(body(1, 2, "stale body"))
      .mockResolvedValueOnce(body(2, 3, "fresh body"));
    const loadChatMessageReversePage = vi.fn()
      .mockResolvedValueOnce(page(2, ["m1", "m2", "m3"], 3))
      .mockResolvedValueOnce(page(2, ["m1", "m2", "m3"], 3));
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatHydration,
      loadChatMessageReversePage,
    };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", detailsLoaded: false, message: [] as any[] }] });

    await expect(ensureChatHydrated(character as any, 0)).resolves.toMatchObject({ name: "fresh body" });
    expect(loadChatHydration).toHaveBeenCalledTimes(2);
    expect(loadChatMessageReversePage).toHaveBeenCalledTimes(2);
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2", "m3"]);
  });

  it("C. an unconvergeable skew degrades to a warning and a loaded chat, never a terminal throw", async () => {
    // Pathological: this chat is written to between EVERY pair of reads, so the
    // body and page snapshots never line up. The messages still come from one
    // snapshot-consistent server read transaction, so the honest outcome is a
    // loaded chat plus a warning — not a chat stuck on its first message.
    let revision = 0;
    let total = 5;
    const loadChatHydration = vi.fn(async () => body(++revision, total));
    const loadChatMessageReversePage = vi.fn(async () => {
      total += 1;
      return page(++revision, ["m1", "m2"], total);
    });
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatHydration,
      loadChatMessageReversePage,
    };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", detailsLoaded: false, message: [] as any[] }] });

    const hydrated = await ensureChatHydrated(character as any, 0);

    expect(hydrated).toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2"]);
    expect((character.chats[0] as any).messagesLoaded).toBe(true);
    expect(getSqlWindow(character.chats[0])).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("[chat-history]");
  });

  it("D. a failed hydration leaves no in-flight or hydration-counter residue", async () => {
    const loadChatHydration = vi.fn(async () => { throw new Error("network down"); });
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatHydration,
      loadChatMessageReversePage: vi.fn(),
    };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", detailsLoaded: false, message: [] as any[] }] });

    await expect(ensureChatHydrated(character as any, 0)).rejects.toThrow(/network down/);
    expect(isHydrationActive(chatHydrationKey("ch1", "c1"))).toBe(false);

    // The next attempt must issue a real request rather than being served the
    // cached rejection (the `trackInFlight` class of bug fixed in v0.3.2.10).
    activeStorage.current.loadChatHydration = vi.fn(async () => body(1, 2));
    activeStorage.current.loadChatMessageReversePage = vi.fn(async () => page(1, ["m1", "m2"]));
    await expect(ensureChatHydrated(character as any, 0)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2"]);
  });

  it("E. rapid A -> B -> A switching leaves A fully hydrated", async () => {
    // Every read advances the shared revision, exactly as a live app with a
    // background commit loop does. Neither chat changes.
    let revision = 100;
    const bodies: Record<string, any> = {
      "c1": { id: "c1", characterId: "ch1", name: "A", message: [], messageTotal: 2, detailsLoaded: true },
      "c2": { id: "c2", characterId: "ch1", name: "B", message: [], messageTotal: 1, detailsLoaded: true },
    };
    const pages: Record<string, string[]> = { "c1": ["a1", "a2"], "c2": ["b1"] };
    const loadChatHydration = vi.fn(async (chatId: string) => ({ revision: ++revision, chat: { ...bodies[chatId] } }));
    const loadChatMessageReversePage = vi.fn(async (chatId: string) => ({
      ...page(++revision, pages[chatId]),
      chatId,
    }));
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatHydration,
      loadChatMessageReversePage,
    };
    const character = $state({
      chaId: "ch1",
      chats: [
        { id: "c1", detailsLoaded: false, message: [] as any[] },
        { id: "c2", detailsLoaded: false, message: [] as any[] },
      ],
    });

    // Start A, switch to B before it settles, then switch straight back to A.
    const firstA = ensureChatMessageWindow(character as any, 0, 40);
    const b = ensureChatMessageWindow(character as any, 1, 40);
    const secondA = ensureChatMessageWindow(character as any, 0, 40);

    await Promise.all([firstA, b, secondA]);

    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["a1", "a2"]);
    expect(character.chats[1].message.map((m: any) => m.chatId)).toEqual(["b1"]);
    expect((character.chats[0] as any).messagesLoaded).toBe(true);
    expect((character.chats[1] as any).messagesLoaded).toBe(true);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 2 });
    expect(isHydrationActive(chatHydrationKey("ch1", "c1"))).toBe(false);
    expect(isHydrationActive(chatHydrationKey("ch1", "c2"))).toBe(false);
  });
});
