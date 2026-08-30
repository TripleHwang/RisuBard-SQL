import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";

import { hasOlderSqlMessages, setSqlWindow, type SqlHydrationWindow } from "./sqlRuntimeWindow";

/**
 * Hydration marks moved from a string-keyed, non-enumerable property to a
 * symbol key, because Svelte 5 rejects the descriptor the old code used. Every
 * consumer that still spelled `chat._sqlWindow` by name now reads `undefined`,
 * and `undefined` here does not surface as an error -- it surfaces as a chat
 * that claims to be complete while holding forty of four hundred messages, or
 * as a disabled button with no way to reach the rest.
 *
 * `.svelte.test.ts` so the runes compile: the chat below is a real `$state`
 * proxy, as the app holds it.
 */

const partialWindow: SqlHydrationWindow = {
  before: null, nextBefore: 360, total: 400, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 400,
};

describe("the previous-page gate reads the live hydration window", () => {
  /**
   * `DefaultChatScreen.svelte` gates the scroll-up loader and the
   * previous-page button on this predicate, inside the template. A correct
   * value that is not *reactive* is the same bug with extra steps: the button
   * would render disabled at mount and never re-enable once hydration recorded
   * a window, leaving older messages unreachable although they are in storage.
   *
   * A symbol key is not obviously reactive -- that it is depends on Svelte's
   * proxy traps being key-agnostic. This is the effect the template's
   * `disabled={...}` compiles to, so the dependency is proven, not assumed.
   */
  test("a gate derived from the accessor re-runs when hydration records a window", () => {
    const chat = $state({ id: "chat-1", message: [{ chatId: "m-360" }] });
    const seen: boolean[] = [];

    const stop = $effect.root(() => {
      $effect(() => { seen.push(hasOlderSqlMessages(chat)); });
    });
    try {
      flushSync();
      expect(seen).toEqual([false]);

      setSqlWindow(chat, partialWindow);
      flushSync();
      // The previous-page button must now be enabled.
      expect(seen).toEqual([false, true]);

      setSqlWindow(chat, { ...partialWindow, hasOlder: false, nextBefore: null });
      flushSync();
      // ...and disabled again once the whole history is resident.
      expect(seen).toEqual([false, true, false]);
    } finally {
      stop();
    }
  });
});
