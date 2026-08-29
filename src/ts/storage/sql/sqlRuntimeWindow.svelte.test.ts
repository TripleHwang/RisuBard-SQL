import { describe, expect, test } from "vitest";

import {
  clearSqlPosition,
  clearSqlWindow,
  getSqlPosition,
  getSqlWindow,
  hasOlderSqlMessages,
  setSqlPosition,
  setSqlWindow,
  stripSqlRuntimeFields,
  type SqlHydrationWindow,
} from "./sqlRuntimeWindow";

/**
 * `.svelte.test.ts` so the runes compile: every object below is a real Svelte 5
 * `$state` proxy, which is the only place these accessors have ever been hard
 * to get right.
 */
function reactiveChat() {
  const state = $state({ id: "chat-1", message: [{ chatId: "m-1" }] });
  return state;
}

const window: SqlHydrationWindow = {
  before: null, nextBefore: 2, total: 3, hasOlder: true, nextPosition: 4,
};

describe("SQL runtime hydration marks on a $state object", () => {
  test("the descriptor route these accessors replace is still rejected by Svelte", () => {
    const chat = reactiveChat();

    // This is the shipped defect, reproduced against the real proxy: a
    // non-enumerable descriptor on a `$state` object throws. If Svelte ever
    // relaxes this, that is a decision to revisit deliberately, not to
    // discover from a blank chat screen.
    expect(() => Object.defineProperty(chat, "_sqlWindow", {
      configurable: true, enumerable: false, writable: true, value: window,
    })).toThrow(/state_descriptors_fixed/);
  });

  test("a window can be stored, read back, and cleared", () => {
    const chat = reactiveChat();
    expect(getSqlWindow(chat)).toBeUndefined();
    expect(hasOlderSqlMessages(chat)).toBe(false);

    setSqlWindow(chat, window);
    expect(getSqlWindow(chat)).toMatchObject(window);
    expect(hasOlderSqlMessages(chat)).toBe(true);

    setSqlWindow(chat, { ...window, hasOlder: false });
    expect(hasOlderSqlMessages(chat)).toBe(false);
    expect(getSqlWindow(chat)?.total).toBe(3);

    clearSqlWindow(chat);
    expect(getSqlWindow(chat)).toBeUndefined();
    // Absence of a window is absence of evidence, and must not read as a
    // finished, fully-loaded chat by some other name.
    expect(hasOlderSqlMessages(chat)).toBe(false);
  });

  test("a canonical position can be stored, read back, and cleared", () => {
    const message = $state({ chatId: "m-1" });

    expect(getSqlPosition(message)).toBeUndefined();
    setSqlPosition(message, 0);
    expect(getSqlPosition(message)).toBe(0);
    setSqlPosition(message, 41);
    expect(getSqlPosition(message)).toBe(41);
    clearSqlPosition(message);
    expect(getSqlPosition(message)).toBeUndefined();
  });

  test("a position that is not a position is refused rather than stored", () => {
    const message = $state({ chatId: "m-1" });

    for (const bad of [-1, 1.5, Number.NaN, Infinity, undefined as unknown as number]) {
      expect(() => setSqlPosition(message, bad)).toThrow(/canonical SQL position/);
    }
    // A bogus position would be written straight into `messages.position`;
    // no position at all is caught loudly at commit time instead.
    expect(getSqlPosition(message)).toBeUndefined();
  });

  test("marks never reach any path that leads to storage", () => {
    const chat = reactiveChat();
    setSqlWindow(chat, window);
    setSqlPosition(chat.message[0], 7);

    expect(Object.keys(chat)).not.toContain("_sqlWindow");
    expect(JSON.stringify(chat)).not.toContain("hasOlder");
    expect(getSqlWindow(JSON.parse(JSON.stringify(chat)))).toBeUndefined();
    expect(getSqlPosition(JSON.parse(JSON.stringify(chat)).message[0])).toBeUndefined();

    const snapshot = $state.snapshot(chat);
    expect(getSqlWindow(snapshot)).toBeUndefined();
    expect(getSqlPosition(snapshot.message[0])).toBeUndefined();
    expect(getSqlWindow(structuredClone(snapshot))).toBeUndefined();
  });

  test("marks do survive a spread, and stripping is what removes them", () => {
    const chat = reactiveChat();
    setSqlWindow(chat, window);
    const message = $state({ chatId: "m-1" });
    setSqlPosition(message, 7);

    // Spread and rest destructuring copy own enumerable symbols, which is why
    // the commit builders strip explicitly instead of trusting the copy.
    const chatCopy = { ...chat };
    const { chatId: _id, ...messageCopy } = message;
    expect(getSqlWindow(chatCopy)).toMatchObject(window);
    expect(getSqlPosition(messageCopy)).toBe(7);

    expect(getSqlWindow(stripSqlRuntimeFields(chatCopy))).toBeUndefined();
    expect(getSqlPosition(stripSqlRuntimeFields(messageCopy))).toBeUndefined();
    // Marks written as ordinary properties by an older build are cleared too.
    expect(stripSqlRuntimeFields({ _sqlWindow: window, _sqlPosition: 7, keep: 1 }))
      .toEqual({ keep: 1 });
    // Stripping the copy must never disturb the live object it came from.
    expect(getSqlWindow(chat)).toMatchObject(window);
    expect(getSqlPosition(message)).toBe(7);
  });
});
