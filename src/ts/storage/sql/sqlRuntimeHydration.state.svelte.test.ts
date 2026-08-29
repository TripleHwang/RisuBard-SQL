import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Chat, character } from "../database.svelte";

const activeStorage = vi.hoisted(() => ({ current: null as any }));

vi.mock("./sqlBootstrap", () => ({
  getActiveSqlStorage: () => activeStorage.current,
}));

const { ensureChatMessageWindow, loadOlderChatMessages } = await import("./sqlRuntimeHydration");

/**
 * The existing sqlRuntimeHydration.test.ts fixtures build their chats as plain
 * object literals. The app does not: `db.characters` is reactive, so every chat
 * the hydrator mutates is a Svelte 5 `$state` proxy. That difference is the
 * entire reason this bug shipped green, so these fixtures hold the chat exactly
 * the way the running app holds it -- and this file is `.svelte.test.ts` so the
 * runes are actually compiled rather than left as bare identifiers.
 */
function reactiveCharacter(messages: Array<{ chatId: string }> = []): character {
  const state = $state({
    chaId: "character-1",
    chatPage: 0,
    chats: [{
      id: "chat-1",
      name: "chat",
      note: "",
      localLore: [],
      message: messages,
      _placeholder: true,
      messagesLoaded: false,
    }],
  });
  return state as unknown as character;
}

/**
 * Records the settled outcome instead of asserting on it, so an assertion about
 * the chat's surviving contents is never masked by (or coupled to) whether the
 * hydration promise resolved. The captured error is fed back into the
 * assertion message so a failure stays observable rather than swallowed.
 */
async function settle(work: Promise<Chat | null>) {
  return work.then(
    (value) => ({ ok: true as const, value, detail: "hydration resolved" }),
    (error) => ({ ok: false as const, value: null, detail: `hydration rejected with: ${error}` }),
  );
}

describe("SQL hydration of a chat held in $state, as the app holds it", () => {
  beforeEach(() => {
    activeStorage.current = null;
  });

  test("opening a chat leaves its messages readable and its window usable", async () => {
    const reverse = vi.fn()
      .mockResolvedValueOnce({
        chatId: "chat-1", messages: [{ chatId: "m-2" }, { chatId: "m-3" }], positions: [2, 3],
        before: null, nextBefore: 2, nextPosition: 4, total: 3, hasMore: true,
      })
      .mockResolvedValueOnce({
        chatId: "chat-1", messages: [{ chatId: "m-1" }], positions: [1],
        before: 2, nextBefore: null, nextPosition: 4, total: 3, hasMore: false,
      });
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: reverse,
    };
    const character = reactiveCharacter();

    const outcome = await settle(ensureChatMessageWindow(character, 0, 40));

    // What the user sees: the newest page is on screen.
    expect(outcome.value, outcome.detail).not.toBeNull();
    expect(
      character.chats[0].message.map((message) => message.chatId),
      outcome.detail,
    ).toEqual(["m-2", "m-3"]);
    expect((character.chats[0] as any)._placeholder, outcome.detail).toBe(false);

    // And the window is usable, asserted behaviourally rather than by reading
    // the private field: scrolling up must actually fetch and prepend the
    // older page, which only happens when the hydrator can find the window it
    // attached during this hydration.
    const older = await settle(loadOlderChatMessages(character, 0, 40));
    expect(reverse, older.detail).toHaveBeenNthCalledWith(2, "chat-1", 2, 40);
    expect(
      character.chats[0].message.map((message) => message.chatId),
      older.detail,
    ).toEqual(["m-1", "m-2", "m-3"]);
  });

  test("a chat whose hydration fails is not left with a replaced, truncated message array", async () => {
    // A chat that already holds its messages -- the state the app is in when a
    // previous load populated the slot, and the state a retry finds itself in
    // after a first hydration attempt died mid-mutation. The newest page is a
    // strict subset of what is resident, so replacing the array instead of
    // splicing into it is directly observable as lost rows.
    const reverse = vi.fn().mockResolvedValue({
      chatId: "chat-1", messages: [{ chatId: "m-3" }], positions: [3],
      before: null, nextBefore: 2, nextPosition: 4, total: 3, hasMore: true,
    });
    activeStorage.current = {
      backendKind: "server-sql",
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: reverse,
    };
    const character = reactiveCharacter([{ chatId: "m-1" }, { chatId: "m-2" }, { chatId: "m-3" }]);
    const resident = character.chats[0].message;

    const outcome = await settle(ensureChatMessageWindow(character, 0, 1));

    // Chats.svelte mounts message rows imperatively and sweeps anything absent
    // from the current window, so an array swapped out from under it unmounts
    // every row -- the blank screen. The array must be spliced, never replaced.
    expect(character.chats[0].message, outcome.detail).toBe(resident);
    expect(
      character.chats[0].message.map((message) => message.chatId),
      outcome.detail,
    ).toEqual(["m-1", "m-2", "m-3"]);
  });
});
