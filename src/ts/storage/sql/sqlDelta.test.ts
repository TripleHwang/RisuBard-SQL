import { describe, expect, it } from "vitest";

import { buildSqlDeltaCommit } from "./sqlDelta";
import { setSqlWindow } from "./sqlRuntimeWindow";

function database() {
  return {
    username: "User",
    temperature: Number.NaN,
    pluginCustomStorage: {
      "pagefold.config.v1": { provider: "google" },
    },
    botPresets: [{ id: "preset-1", name: "Default" }],
    botPresetsId: 0,
    characters: [
      {
        chaId: "character-1",
        name: "Character",
        chats: [
          {
            id: "chat-1",
            name: "Chat",
            message: [
              { chatId: "message-1", role: "user", data: "hello" },
              { chatId: "message-2", role: "char", data: "world" },
            ],
          },
        ],
      },
    ],
  } as any;
}

describe("SQL delta commits", () => {
  it("does not write an unchanged upstream-compatible graph", () => {
    const before = database();
    const after = structuredClone(before);
    expect(buildSqlDeltaCommit(before, after, 3)).toBeNull();
  });

  it("updates one message without rewriting its chat or character", () => {
    const before = database();
    const after = structuredClone(before);
    after.characters[0].chats[0].message[1].data = "edited";

    const commit = buildSqlDeltaCommit(before, after, 3)!;

    expect(commit.root.upserts).toHaveLength(0);
    expect(commit.characters).toHaveLength(0);
    expect(commit.chats).toHaveLength(0);
    expect(commit.messages).toEqual([
      expect.objectContaining({ id: "message-2", chatId: "chat-1" }),
    ]);
  });

  it("uses manifests for deletions and SQL-backed plugin settings", () => {
    const before = database();
    const after = structuredClone(before);
    after.characters[0].chats[0].message.pop();
    after.pluginCustomStorage["pagefold.config.v1"].provider = "openrouter";

    const commit = buildSqlDeltaCommit(before, after, 3)!;

    expect(commit.messageManifests).toEqual([
      { chatId: "chat-1", ids: ["message-1"] },
    ]);
    expect(commit.pluginStorage?.upserts).toEqual([
      {
        key: "pagefold.config.v1",
        value: { provider: "openrouter" },
      },
    ]);
  });

  it("keeps canonical message rows when the current chat is only a partial SQL window", () => {
    const before = database();
    const after = structuredClone(before);
    after.characters[0].chats[0].message = [after.characters[0].chats[0].message[1]];
    after.characters[0].chats[0].name = "Renamed while windowed";
    after.characters[0].chats[0].messagesLoaded = true;
    after.characters[0].chats[0].messagesFullyLoaded = false;
    setSqlWindow(after.characters[0].chats[0], {
      before: null, nextBefore: 0, total: 2, hasOlder: true, nextPosition: 2,
    });

    const commit = buildSqlDeltaCommit(before, after, 3)!;

    expect(commit.chats).toEqual([expect.objectContaining({ id: "chat-1" })]);
    expect(commit.messages).toEqual([]);
    expect(commit.messageManifests).toEqual([]);
  });
});
