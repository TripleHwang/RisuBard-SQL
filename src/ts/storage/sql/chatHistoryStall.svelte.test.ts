// Regression suite for the chat history pagination stall (v0.3.2.8).
//
// Every case below started life asserting the BROKEN behavior — the repro that
// diagnosed the bug. Each now pins the fixed behavior instead, so the exact
// stall the user hit ("scroll up, get a Retry button that never works") cannot
// come back.
import { describe, expect, it, vi, beforeEach } from "vitest";

const activeStorage = { current: null as any };
vi.mock("./sqlBootstrap", () => ({ getActiveSqlStorage: () => activeStorage.current }));

import { ensureChatMessageWindow, loadOlderChatMessages } from "./sqlRuntimeHydration";
import { getSqlWindow, setSqlPosition, setSqlWindow } from "./sqlRuntimeMeta";
import { createContinuousHistoryController } from "../../chatWindow";

/** Lets an already-created in-flight entry register before the next call observes it. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("older-page stall", () => {
  beforeEach(() => { activeStorage.current = null; });

  it("A. a new persisted message refreshes the window instead of poisoning every later page", async () => {
    // newest page: 2 of 4 messages, positions 8/12, MAX(position)+1 = 13
    const first = { chatId: "c1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true };
    // After the user sends one message the server COUNT(*) is 5 and MAX+1 is 14.
    // The older page itself is perfectly correct and contiguous. `total` and
    // `nextPosition` are live chat-wide counters, so they MUST be allowed to
    // move without invalidating the page.
    const older = () => ({ chatId: "c1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 14, before: 8, nextBefore: null, total: 5, hasMore: false });

    const reverse = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(older());
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };

    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 2);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 4, nextPosition: 13, hasOlder: true, nextBefore: 8 });

    // The user sends a message; it is appended and committed to SQL. A dirty
    // commit allocates its canonical position from the window watermark
    // (`allocateAppendedPositions`, sqlDirtyCommit.ts), so a committed message
    // always carries one — that is what makes it visible to the server COUNT.
    const sent = { chatId: "m4" } as any;
    setSqlPosition(sent, 13);
    character.chats[0].message.push(sent);

    // scroll up -> the older page loads, first time and every time
    await expect(loadOlderChatMessages(character as any, 0, 2)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);

    // the window was re-established from the page, not left at its capture value
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 5, hasOlder: false, nextBefore: null });
    // `nextPosition` keeps a monotonic floor: it is the allocator watermark for
    // appended messages, so it may only ever rise.
    expect(getSqlWindow(character.chats[0])!.nextPosition).toBe(14);

    // nothing older is left, so further calls are quiet no-ops rather than errors
    await expect(loadOlderChatMessages(character as any, 0, 2)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("A2. a moved nextPosition alone (total unchanged, e.g. delete+add) no longer rejects the page", async () => {
    const first = { chatId: "c1", messages: [{ chatId: "m2" }], positions: [8], nextPosition: 9, before: 9, nextBefore: 8, total: 3, hasMore: true };
    const older = { chatId: "c1", messages: [{ chatId: "m1" }], positions: [4], nextPosition: 10, before: 8, nextBefore: 4, total: 3, hasMore: true };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(older) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 1);
    await expect(loadOlderChatMessages(character as any, 0, 1)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2"]);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ nextBefore: 4, hasOlder: true, nextPosition: 10 });
  });

  it("A3. a locally appended, uncommitted message is not counted as persisted coverage", async () => {
    // The server sees 4 messages (m0..m3); we hold the newest two.
    const first = { chatId: "c1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true };
    // A terminal page that only reaches back to m1 — m0 was never fetched.
    const truncated = { chatId: "c1", messages: [{ chatId: "m1" }], positions: [4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(truncated) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 2);

    // A draft/appended message that has NOT been committed yet: no canonical
    // position, and no row behind the server's COUNT(*). Counting it toward
    // coverage would make 3 known + 1 page === total 4 hold, concluding "we
    // have everything" while m0 was still unfetched — silently losing history.
    character.chats[0].message.push({ chatId: "m4" } as any);

    await expect(loadOlderChatMessages(character as any, 0, 2)).rejects.toThrow(/terminal coverage is incomplete/);
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m2", "m3", "m4"]);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ total: 4, hasOlder: true, nextBefore: 8 });
  });

  it("B. what the UI controller observes: the viewport fills and no Retry appears", async () => {
    const first = { chatId: "c1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true };
    const older = { chatId: "c1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 14, before: 8, nextBefore: null, total: 5, hasMore: false };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(older) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 2);

    // the sent-and-committed message that used to break every later page
    const sent = { chatId: "m4" } as any;
    setSqlPosition(sent, 13);
    character.chats[0].message.push(sent);

    // mirror DefaultChatScreen.svelte's controller wiring
    const controller = createContinuousHistoryController({
      hasOlder: () => !!getSqlWindow(character.chats[0])?.hasOlder,
      isScrollable: () => false,                       // short viewport: autofill wants more
      progress: () => character.chats[0].message.length,
      loadOlder: async () => {
        try { await loadOlderChatMessages(character as any, 0, 2) } catch { return false }
        return true
      },
    });

    await expect(controller.fillViewport()).resolves.toBe(true);
    expect(controller.failed).toBe(false);             // no Retry button
    expect(controller.loading).toBe(false);
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);

    // and a retry with nothing left to load resolves cleanly rather than failing
    await controller.retry();
    expect(controller.failed).toBe(false);
  });

  it("C. an all-duplicates page is a hard, distinguishable error, never a silent 'history complete'", async () => {
    // The unreachable "server returned only messages we already have, stop
    // paginating" recovery was removed rather than made reachable: reaching it
    // required weakening duplicate detection, and its recovery flipped
    // hasOlder=false, silently hiding whatever history was really still there.
    // A duplicate page keeps its own error string so a console line pins it.
    const first = { chatId: "c1", messages: [{ chatId: "m2" }], positions: [8], nextPosition: 9, before: 9, nextBefore: 8, total: 2, hasMore: true };
    const dup = { chatId: "c1", messages: [{ chatId: "m2" }], positions: [8], nextPosition: 9, before: 8, nextBefore: 8, total: 2, hasMore: true };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(dup) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 1);
    await expect(loadOlderChatMessages(character as any, 0, 1)).rejects.toThrow(/duplicate message IDs/);
    // never silently declares the history complete...
    expect(getSqlWindow(character.chats[0])?.hasOlder).toBe(true);
    // ...and never merges the duplicate
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m2"]);
  });

  it("D. loadOlder during initial hydration performs its own fetch instead of impersonating it", async () => {
    let release!: (value: any) => void;
    const gate = new Promise((resolve) => { release = resolve });
    const first = { chatId: "c1", messages: [{ chatId: "m2" }, { chatId: "m3" }], positions: [8, 12], nextPosition: 13, before: 13, nextBefore: 8, total: 4, hasMore: true };
    const older = { chatId: "c1", messages: [{ chatId: "m0" }, { chatId: "m1" }], positions: [0, 4], nextPosition: 13, before: 8, nextBefore: null, total: 4, hasMore: false };
    const reverse = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(older);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });

    const hydrating = ensureChatMessageWindow(character as any, 0, 2);
    await flush();
    // Sharing one in-flight map handed this call the hydration's promise: it
    // fetched nothing and resolved truthy with the message count unchanged,
    // which the autofill's no-progress detector reports as a SPURIOUS Retry.
    const olderLoad = loadOlderChatMessages(character as any, 0, 2);
    release(first);
    await hydrating;
    await olderLoad;

    expect(reverse).toHaveBeenCalledTimes(2);
    expect(reverse).toHaveBeenNthCalledWith(2, "c1", 8, 2);
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  // The fixtures above hand-write `nextBefore: null` on a terminal page. The
  // real server (`server/node/relational-sqlite.cjs`) has never returned that
  // for a NON-EMPTY page: before this fix it reported the page's own lowest
  // position, so the final page of every chat failed the boundary check and
  // scrolling up died in a permanent Retry. `serverStub` below reproduces the
  // server's actual algorithm — including the older `nextBefore` convention —
  // instead of a shape written to match the assertion.
  const serverStub = (positions: number[], { legacyTerminalCursor = false } = {}) => {
    const rows = positions.map((position, index) => ({ id: `s${index}`, position }));
    const nextPosition = rows.length ? Math.max(...positions) + 1 : 0;
    return vi.fn(async (_chatId: string, before: number | undefined, limit: number) => {
      const normalizedBefore = before ?? nextPosition;
      const descending = rows.filter((row) => row.position < normalizedBefore)
        .sort((a, b) => b.position - a.position).slice(0, limit + 1);
      const page = descending.slice(0, limit).reverse();
      const hasMore = descending.length > limit;
      return {
        // Matches the other fixtures here: the chat is built inline without a
        // body hydration, so it carries no `_sqlHydrationRevision` to compare.
        chatId: "c1",
        messages: page.map((row) => ({ chatId: row.id })),
        positions: page.map((row) => row.position),
        nextPosition, before: normalizedBefore,
        // The whole point: what a real server puts here on a terminal page.
        nextBefore: legacyTerminalCursor
          ? (page.length ? page[0].position : null)
          : (hasMore && page.length ? page[0].position : null),
        total: rows.length, hasMore,
      };
    });
  };

  const walkToOldest = async (character: any, limit: number) => {
    for (let guard = 0; getSqlWindow(character.chats[0])?.hasOlder; guard += 1) {
      expect(guard).toBeLessThan(20);        // a cursor that never advances fails here
      await loadOlderChatMessages(character, 0, limit);
    }
    return character.chats[0].message.map((m: any) => m.chatId);
  };

  it("F. scrolling to the oldest message succeeds against the server's real page shape", async () => {
    // Sparse positions, because real ones are sparse: 0, 4, 8, 12 ...
    const reverse = serverStub([0, 4, 8, 12, 16, 20, 24]);
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });

    await ensureChatMessageWindow(character as any, 0, 3);
    await expect(walkToOldest(character, 3)).resolves.toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(getSqlWindow(character.chats[0])).toMatchObject({ hasOlder: false, nextBefore: null });
  });

  it("F2. a server still using the old terminal-cursor convention is adapted to, not rejected", async () => {
    // A cached browser bundle and a server are updated at slightly different
    // moments, so the client must survive a terminal page that reports its own
    // lowest position instead of null. `hasMore: false` already ends the walk;
    // disagreeing about the spare value must never brick history browsing.
    const reverse = serverStub([0, 4, 8, 12], { legacyTerminalCursor: true });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });

    await ensureChatMessageWindow(character as any, 0, 2);
    await expect(walkToOldest(character, 2)).resolves.toEqual(["s0", "s1", "s2", "s3"]);
    // Normalized on the way into the window, so nothing re-requests the page.
    expect(getSqlWindow(character.chats[0])).toMatchObject({ hasOlder: false, nextBefore: null });
  });

  it("F3. no Retry button appears while the controller autofills to the oldest message", async () => {
    const reverse = serverStub([0, 4, 8, 12, 16], { legacyTerminalCursor: true });
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: reverse };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    await ensureChatMessageWindow(character as any, 0, 2);

    const controller = createContinuousHistoryController({
      hasOlder: () => !!getSqlWindow(character.chats[0])?.hasOlder,
      isScrollable: () => false,
      progress: () => character.chats[0].message.length,
      loadOlder: async () => {
        try { await loadOlderChatMessages(character as any, 0, 2) } catch { return false }
        return true
      },
    });

    await expect(controller.fillViewport()).resolves.toBe(true);
    expect(controller.failed).toBe(false);
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("F4. tied positions inside one page are merged rather than rejected", async () => {
    // `messages(chat_id, position)` has no UNIQUE constraint, so two rows can
    // share a position; the server widens a page over the whole tied group
    // rather than splitting it. A tie inside a page loses nothing, so the
    // validator must not treat it as corruption.
    const first = { chatId: "c1", messages: [{ chatId: "m3" }], positions: [12], nextPosition: 13, before: 13, nextBefore: 12, total: 3, hasMore: true };
    const tied = { chatId: "c1", messages: [{ chatId: "m1" }, { chatId: "m2" }], positions: [8, 8], nextPosition: 13, before: 12, nextBefore: null, total: 3, hasMore: false };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(tied) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });

    await ensureChatMessageWindow(character as any, 0, 1);
    await expect(loadOlderChatMessages(character as any, 0, 1)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m1", "m2", "m3"]);
  });

  it("F5. a continuing page whose cursor does not match its own lowest position is still refused", async () => {
    // Leniency is scoped to the terminal page. A `hasMore` page whose cursor
    // disagrees with its contents would make the NEXT request skip or repeat
    // messages, which is real data loss, not a convention difference.
    const first = { chatId: "c1", messages: [{ chatId: "m3" }], positions: [12], nextPosition: 13, before: 13, nextBefore: 12, total: 4, hasMore: true };
    const skewed = { chatId: "c1", messages: [{ chatId: "m2" }], positions: [8], nextPosition: 13, before: 12, nextBefore: 4, total: 4, hasMore: true };
    activeStorage.current = { backendKind: "server-sql", loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(skewed) };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });

    await ensureChatMessageWindow(character as any, 0, 1);
    await expect(loadOlderChatMessages(character as any, 0, 1)).rejects.toThrow(/boundary is noncontiguous/);
  });

  it("E. a sync throw from storage does not poison the in-flight map", async () => {
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      // NOT an async function: throws synchronously, so its cleanup used to run
      // before the in-flight entry was ever registered.
      loadChatMessageReversePage: vi.fn(() => { throw new Error("boom") }),
    };
    const character = $state({ chaId: "ch1", chats: [{ id: "c1", message: [] as any[] }] });
    setSqlWindow(character.chats[0], { before: 13, nextBefore: 8, total: 1, hasOlder: true, nextPosition: 13 });

    await expect(loadOlderChatMessages(character as any, 0, 2)).rejects.toThrow(/boom/);

    // Once the storage is healthy again the retry must actually retry, rather
    // than being served a rejected promise cached after its own `finally` ran.
    activeStorage.current.loadChatMessageReversePage = vi.fn().mockResolvedValue(
      { chatId: "c1", messages: [{ chatId: "m0" }], positions: [0], nextPosition: 13, before: 8, nextBefore: null, total: 1, hasMore: false });
    await expect(loadOlderChatMessages(character as any, 0, 2)).resolves.toBeTruthy();
    expect(character.chats[0].message.map((m: any) => m.chatId)).toEqual(["m0"]);
    expect(activeStorage.current.loadChatMessageReversePage).toHaveBeenCalledTimes(1);
  });
});
