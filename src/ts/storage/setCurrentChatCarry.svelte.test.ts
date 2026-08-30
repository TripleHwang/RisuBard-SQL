/**
 * `setCurrentChat` is the other place a trigger's structured clone lands on the
 * live chat slot.
 *
 * Three call sites use it and all three are trigger write-backs: the `manual`
 * trigger fired from a message button (`Chat.svelte`), the `/trigger` command
 * (`process/command.ts`), and the `start` trigger that runs on every send
 * (`process/index.svelte.ts`). Each hands it a `safeStructuredClone` of the
 * chat, so each drops the symbol-keyed SQL runtime marks exactly as the output
 * trigger did -- and the `start` trigger runs before the request, on every
 * message, for any character that has a trigger script at all.
 *
 * Two properties are asserted here: the marks survive, and the function hands
 * back the object that is IN the slot rather than the detached clone it was
 * given.
 */
import { get } from "svelte/store";
import { beforeEach, describe, expect, it } from "vitest";

import { selectedCharID } from "../stores.svelte";
import type { Chat, Database, character } from "./database.svelte";
import { getCurrentChat, setCurrentChat, setDatabaseLite } from "./database.svelte";
import {
  getSqlPosition,
  getSqlWindow,
  hasOlderSqlMessages,
  setSqlPosition,
  setSqlWindow,
  type SqlHydrationWindow,
} from "./sql/sqlRuntimeWindow";

const WINDOW: SqlHydrationWindow = {
  before: null,
  nextBefore: 32,
  total: 40,
  hasOlder: true,
  hasNewer: false,
  nextAfter: null,
  nextPosition: 40,
};

function installDatabase(): character {
  const chat = {
    id: "chat-set-current",
    name: "Chat 0",
    note: "",
    localLore: [],
    message: [
      { role: "user", data: "m0", chatId: "a" },
      { role: "char", data: "m1", chatId: "b" },
    ],
    messagesLoaded: true,
    messagesFullyLoaded: false,
  } as unknown as Chat;

  setDatabaseLite({
    characters: [{
      chaId: "character-set-current",
      type: "character",
      name: "Ada",
      chatPage: 0,
      chats: [chat],
    }],
  } as unknown as Database);
  selectedCharID.set(0);

  // Mark through the LIVE slot, as hydration does -- `DBState.db` wrapped the
  // object above, so the raw `chat` here is not what the application reads.
  const live = getCurrentChat();
  setSqlWindow(live, WINDOW);
  live.message.forEach((message, index) => setSqlPosition(message, 32 + index));
  expect(getSqlWindow(getCurrentChat())).toEqual(WINDOW);

  return null as unknown as character;
}

/** `runTrigger` (process/triggers.ts:1077): the chat a trigger returns. */
function triggerClone(): Chat {
  return {
    id: "chat-set-current",
    name: "Chat 0",
    note: "",
    localLore: [],
    message: [
      { role: "user", data: "m0 edited by the trigger", chatId: "a" },
      { role: "char", data: "m1", chatId: "b" },
      { role: "char", data: "added by the trigger", chatId: "c" },
    ],
    messagesLoaded: true,
    messagesFullyLoaded: false,
  } as unknown as Chat;
}

describe("setCurrentChat", () => {
  beforeEach(() => {
    installDatabase();
  });

  it("carries the hydration window and the canonical positions onto the new slot", () => {
    const clone = triggerClone();
    expect(getSqlWindow(clone)).toBeUndefined();

    setCurrentChat(clone);

    const live = getCurrentChat();
    expect({
      window: getSqlWindow(live),
      greetingGateWouldOpen: !hasOlderSqlMessages(live),
      positions: live.message.map((message) => getSqlPosition(message)),
      edit: live.message[0].data,
    }).toEqual({
      window: WINDOW,
      greetingGateWouldOpen: false,
      // The message the trigger added carries none: it is a new row, and
      // `allocateAppendedPositions` is what positions new rows.
      positions: [32, 33, undefined],
      edit: "m0 edited by the trigger",
    });
  });

  it("returns the object in the slot, not the clone it was handed", () => {
    const clone = triggerClone();
    const returned = setCurrentChat(clone);

    expect(returned).toBe(getCurrentChat());
    expect(returned).not.toBe(clone);
    // The proof that the distinction matters: a write to the clone does not
    // reach the chat the application reads.
    clone.note = "written to the detached clone";
    expect(getCurrentChat().note).toBe("");
    // A write to the returned value does.
    returned.note = "written through the slot";
    expect(getCurrentChat().note).toBe("written through the slot");
    // And `selectedCharID` still resolves the same character.
    expect(get(selectedCharID)).toBe(0);
  });
});
