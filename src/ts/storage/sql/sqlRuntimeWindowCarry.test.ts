// @vitest-environment node
/**
 * WHERE the SQL runtime marks have to be written when a chat slot is replaced.
 *
 * `replaceChatSlotCarryingSqlRuntimeFields` writes them onto the value read back
 * OUT of the slot, not onto the raw object on its way in. That choice is not
 * cosmetic, and this file is the proof.
 *
 * A Svelte 5 `$state` proxy never writes through to the object it wraps
 * (`proxy.js`'s `set` trap updates a signal and returns; there is no
 * `Reflect.set`), and its `get` trap only falls through to the target for a key
 * it has no source for. The first read of an ABSENT key installs a source pinned
 * to `UNINITIALIZED` -- and from that instant, a write to the raw target under
 * that key is invisible through the proxy forever.
 *
 * So "mark the raw object, then assign" is not equivalent to "assign, then mark
 * the slot". It only looks equivalent while nothing has read the key through the
 * proxy first, and the code that does exactly that read is ordinary: the
 * greeting gate, the scroll loader and `isChatHistoryIncomplete` all ask a chat
 * for its window, and one of them running against the new proxy before the marks
 * were carried would poison the key.
 *
 * Node environment and Svelte's `proxy()` called directly, for the reason
 * `sqlProxyPersistenceLive.test.ts` documents: under the server transform
 * `$state` compiles to a plain assignment and creates no proxy at all, so a
 * fixture written with `$state` here would hold a raw object and could not
 * observe any of this.
 */
import { proxy } from "svelte/internal/client";
import { describe, expect, it } from "vitest";

import type { Chat } from "../database.svelte";
import {
  carrySqlRuntimeFields,
  getSqlPosition,
  getSqlWindow,
  hasOlderSqlMessages,
  replaceChatSlotCarryingSqlRuntimeFields,
  setSqlPosition,
  setSqlWindow,
  type SqlHydrationWindow,
} from "./sqlRuntimeWindow";

const WINDOW: SqlHydrationWindow = {
  before: null,
  nextBefore: 32,
  total: 40,
  hasOlder: true,
  hasNewer: false,
  nextAfter: null,
  nextPosition: 40,
};

function chatWithMarks(ids: string[]): Chat {
  const chat = {
    id: "chat-carry",
    name: "Chat",
    note: "",
    localLore: [],
    message: ids.map((chatId, index) => ({ role: "char", data: `m${index}`, chatId })),
  } as unknown as Chat;
  setSqlWindow(chat, WINDOW);
  chat.message.forEach((message, index) => setSqlPosition(message, 32 + index));
  return chat;
}

/** A `$state` array of chats, as `character.chats` is in the running app. */
function liveChats(chats: Chat[]): Chat[] {
  const raw = { chats };
  const live = proxy(raw) as { chats: Chat[] };
  // Pin the defining property of the fixture: it must NOT write through.
  (live as unknown as Record<string, unknown>).probe = "through the proxy";
  expect((raw as unknown as Record<string, unknown>).probe).toBeUndefined();
  return live.chats;
}

describe("carrying SQL runtime marks across a chat-slot replacement", () => {
  it("marks the object in the slot, not the raw object that was assigned", () => {
    const chats = liveChats([chatWithMarks(["a", "b"])]);
    const replacement = { id: "chat-carry", message: [{ role: "char", data: "m0", chatId: "a" }] } as unknown as Chat;

    const live = replaceChatSlotCarryingSqlRuntimeFields(chats, 0, replacement);

    expect(live).not.toBe(replacement);
    expect(live).toBe(chats[0]);
    // Every reader in the application reaches the chat through the slot, and
    // the marks are there.
    expect(getSqlWindow(chats[0])).toEqual(WINDOW);
    expect(getSqlPosition(chats[0].message[0])).toBe(32);
    // They are deliberately NOT on the detached raw object. Nothing reads it,
    // and a copy there would be a second source of truth that cannot be kept
    // in step with the slot.
    expect(getSqlWindow(replacement)).toBeUndefined();
    expect(getSqlPosition(replacement.message[0])).toBeUndefined();
  });

  /**
   * The ordering hazard itself, demonstrated on the alternative that was
   * rejected: mark the raw object first, then assign.
   */
  it("is immune to a read that would have poisoned a mark written before the assignment", () => {
    // Mark-then-assign, with an innocent read of the key in between -- which is
    // what any greeting gate, scroll loader or completeness guard does.
    const naiveChats = liveChats([chatWithMarks(["a"])]);
    const naiveReplacement = { id: "chat-carry", message: [{ role: "char", data: "m0", chatId: "a" }] } as unknown as Chat;
    setSqlWindow(naiveReplacement, WINDOW);
    naiveChats[0] = naiveReplacement;
    // Reading the window through the fresh proxy BEFORE the raw object carried
    // one would be enough to poison it; here it is already carried, so this read
    // is the honest control and it succeeds.
    expect(hasOlderSqlMessages(naiveChats[0])).toBe(true);

    // Now the order that actually occurs when the mark is written late: the
    // proxy is asked for a key the target does not have yet, and the answer is
    // cached.
    const poisonedChats = liveChats([chatWithMarks(["a"])]);
    const poisonedReplacement = { id: "chat-carry", message: [{ role: "char", data: "m0", chatId: "a" }] } as unknown as Chat;
    poisonedChats[0] = poisonedReplacement;
    expect(hasOlderSqlMessages(poisonedChats[0])).toBe(false);
    setSqlWindow(poisonedReplacement, WINDOW);
    // The mark is on the raw object and the slot cannot see it. This is the
    // failure mode that "mark the raw object first" is one stray read away from.
    expect(getSqlWindow(poisonedReplacement)).toEqual(WINDOW);
    expect(getSqlWindow(poisonedChats[0])).toBeUndefined();

    // Writing through the slot has no such condition: the same poisoned read
    // first, and the carry still lands.
    const carriedChats = liveChats([chatWithMarks(["a"])]);
    const carriedReplacement = { id: "chat-carry", message: [{ role: "char", data: "m0", chatId: "a" }] } as unknown as Chat;
    const previous = carriedChats[0];
    carriedChats[0] = carriedReplacement;
    expect(hasOlderSqlMessages(carriedChats[0])).toBe(false);
    carrySqlRuntimeFields(previous, carriedChats[0]);
    expect(hasOlderSqlMessages(carriedChats[0])).toBe(true);
    expect(getSqlWindow(carriedChats[0])).toEqual(WINDOW);
  });

  it("carries nothing when the slot was not actually replaced", () => {
    const chats = liveChats([chatWithMarks(["a"])]);
    const same = chats[0];
    expect(replaceChatSlotCarryingSqlRuntimeFields(chats, 0, same)).toBe(same);
    expect(getSqlWindow(chats[0])).toEqual(WINDOW);
    expect(getSqlPosition(chats[0].message[0])).toBe(32);
  });

  it("never overwrites a position the replacement already carries", () => {
    const chats = liveChats([chatWithMarks(["a"])]);
    const replacement = { id: "chat-carry", message: [{ role: "char", data: "m0", chatId: "a" }] } as unknown as Chat;
    setSqlPosition(replacement.message[0], 7);

    const live = replaceChatSlotCarryingSqlRuntimeFields(chats, 0, replacement);
    expect(getSqlPosition(live.message[0])).toBe(7);
  });

  it("leaves a window the replacement already carries alone", () => {
    const chats = liveChats([chatWithMarks(["a"])]);
    const ownWindow: SqlHydrationWindow = { ...WINDOW, total: 99, nextPosition: 99 };
    const replacement = { id: "chat-carry", message: [] } as unknown as Chat;
    setSqlWindow(replacement, ownWindow);

    const live = replaceChatSlotCarryingSqlRuntimeFields(chats, 0, replacement);
    expect(getSqlWindow(live)).toEqual(ownWindow);
  });

  it("ignores messages with no usable id in either direction", () => {
    const previous = chatWithMarks(["a"]);
    previous.message.push({ role: "char", data: "no id" } as never);
    setSqlPosition(previous.message[1], 33);
    const chats = liveChats([previous]);

    const replacement = {
      id: "chat-carry",
      message: [{ role: "char", data: "no id" }, { role: "char", data: "m0", chatId: "a" }],
    } as unknown as Chat;

    const live = replaceChatSlotCarryingSqlRuntimeFields(chats, 0, replacement);
    expect(getSqlPosition(live.message[0])).toBeUndefined();
    expect(getSqlPosition(live.message[1])).toBe(32);
  });

  it("does nothing when either side is missing or not a chat", () => {
    const previous = chatWithMarks(["a"]);
    expect(() => carrySqlRuntimeFields(previous, null)).not.toThrow();
    expect(() => carrySqlRuntimeFields(null, previous)).not.toThrow();
    expect(() => carrySqlRuntimeFields(undefined, undefined)).not.toThrow();
    // A chat with no resident array is not an error; there is simply nothing to
    // match against.
    const noMessages = { id: "chat-carry" } as unknown as Chat;
    carrySqlRuntimeFields(previous, noMessages);
    expect(getSqlWindow(noMessages)).toEqual(WINDOW);
  });
});
