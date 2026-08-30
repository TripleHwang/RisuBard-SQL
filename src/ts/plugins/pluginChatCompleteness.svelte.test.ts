import { describe, expect, test } from "vitest";

import { isPluginChatComplete } from "./plugins.svelte";
import { setSqlWindow, type SqlHydrationWindow } from "../storage/sql/sqlRuntimeWindow";

/**
 * `isPluginChatComplete` decides whether a plugin is handed a chat at all.
 *
 * The stakes are the reason it consults the hydration window: a plugin handed
 * a partially resident chat, that then writes the chat back, replaces the
 * persisted history with the resident window. The rest is gone.
 *
 * The window is symbol-keyed runtime state, so this asserts against the real
 * accessor and the real predicate. A test that hand-built a `_sqlWindow`
 * property would pass while production answered "complete" for every partially
 * loaded chat.
 *
 * `.svelte.test.ts` so the runes compile: the chat is a real `$state` proxy.
 */

const partialWindow: SqlHydrationWindow = {
  before: null, nextBefore: 360, total: 400, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 400,
};

describe("chats offered to plugins", () => {
  test("a chat whose older messages are still in storage is refused", () => {
    const resident = $state({
      id: "chat-1", message: [{ chatId: "m-360" }],
      messagesLoaded: true, messagesFullyLoaded: true,
    });

    expect(isPluginChatComplete(resident)).toBe(true);

    setSqlWindow(resident, partialWindow);
    expect(isPluginChatComplete(resident)).toBe(false);

    setSqlWindow(resident, { ...partialWindow, hasOlder: false });
    expect(isPluginChatComplete(resident)).toBe(true);
  });

  test("a chat whose newest messages were released is refused too", () => {
    // Residency trimming releases the newest end once the user has paged far
    // enough back, and by then nothing is older. The flags are left saying
    // "loaded" on purpose: this pins the window predicate rather than passing
    // on `messagesFullyLoaded === false`, which trimming also clears. A plugin
    // handed this slice and writing it back replaces the persisted history with
    // a window missing the end of the conversation.
    const trimmed = $state({
      id: "chat-1", message: [{ chatId: "m-100" }],
      messagesLoaded: true, messagesFullyLoaded: true,
    });
    setSqlWindow(trimmed, {
      before: null, nextBefore: null, total: 400, hasOlder: false, hasNewer: true,
      nextAfter: 279, nextPosition: 400,
    });

    expect(isPluginChatComplete(trimmed)).toBe(false);
  });

  test("the checks for a chat that was never hydrated still stand on their own", () => {
    // No window is "no evidence", not "nothing older". These are the flags
    // that catch a slot which never held messages in the first place.
    expect(isPluginChatComplete(null)).toBe(false);
    expect(isPluginChatComplete({ _stub: true })).toBe(false);
    expect(isPluginChatComplete({ message: [], _placeholder: true })).toBe(false);
    expect(isPluginChatComplete({ message: [], messagesLoaded: false })).toBe(false);
    expect(isPluginChatComplete({ message: [], messagesFullyLoaded: false })).toBe(false);
    expect(isPluginChatComplete({ message: [] })).toBe(true);
  });
});

describe("a chat whose own settings have not been read", () => {
  test("is refused even when its whole history is resident", () => {
    // The bootstrap summary shape: the four real columns on `chats`, a fully
    // loaded message list, and none of `localLore`, `fmIndex`, the
    // persona/preset bindings, the memory data or the script state -- all of
    // which live in `chat_extension_nodes` and arrive only on hydration. A
    // plugin handed this reads an empty lorebook and no bindings on a chat that
    // has both.
    const summary = $state({
      id: "chat-1", name: "Chat 0", note: "", message: [{ chatId: "m-0" }],
      messagesLoaded: true, messagesFullyLoaded: true,
      detailsLoaded: false,
    });

    expect(isPluginChatComplete(summary)).toBe(false);

    summary.detailsLoaded = true;
    expect(isPluginChatComplete(summary)).toBe(true);
  });

  test("a chat created in this session, which never had the flag, is allowed", () => {
    const fresh = $state({
      id: "chat-2", name: "New chat", note: "", localLore: [], message: [],
      messagesLoaded: true, messagesFullyLoaded: true,
    });

    expect(isPluginChatComplete(fresh)).toBe(true);
  });
});
