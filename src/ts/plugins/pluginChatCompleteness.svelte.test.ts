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
  before: null, nextBefore: 360, total: 400, hasOlder: true, nextPosition: 400,
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
