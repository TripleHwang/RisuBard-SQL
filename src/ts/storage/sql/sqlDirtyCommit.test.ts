import { describe, expect, it } from "vitest";

import type { DirtySnapshot } from "./dirtyRegistry";
import { buildSqlDirtyCommit } from "./sqlDirtyCommit";

const cleanDirty = (): DirtySnapshot => ({
  rootKeys: [], characterIds: [], chats: [], messages: [],
  messageManifestChatIds: [], messageDeletes: [], pluginStorageKeys: [], presetIds: [],
});

function fixtureDatabaseWithMessages(count: number) {
  return {
    characters: [{ chaId: "character-a", chats: [{ id: "chat-a", message: Array.from({ length: count }, (_, position) => ({
      chatId: `m-${position}`, role: "char", data: `message-${position}`,
    })) }] }],
    botPresets: [], pluginCustomStorage: {},
  } as any;
}

describe("row-scoped SQL dirty commits", () => {
  it("serializes only a dirty message row in a 20,000-message chat", () => {
    const db = fixtureDatabaseWithMessages(20_000);
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-19999"] }];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.messages).toEqual([expect.objectContaining({ id: "m-19999", chatId: "chat-a", position: 19_999 })]);
    expect(commit.messageManifests).toEqual([]);
  });

  it("indexes a touched chat once for multiple dirty message IDs", () => {
    const db = fixtureDatabaseWithMessages(20_000);
    const messages = db.characters[0].chats[0].message;
    messages.findIndex = () => { throw new Error("per-message linear lookup is forbidden"); };
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-19998", "m-19999"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "m-19998", position: 19_998 },
      { id: "m-19999", position: 19_999 },
    ]);
  });

  it("uses a delete list and complete manifest without sending siblings", () => {
    const db = fixtureDatabaseWithMessages(3);
    const dirty = cleanDirty();
    dirty.messageDeletes = [{ chatId: "chat-a", messageIds: ["m-2"] }];
    dirty.messageManifestChatIds = ["chat-a"];
    db.characters[0].chats[0].message.pop();

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.messageDeletes).toEqual([{ chatId: "chat-a", ids: ["m-2"] }]);
    expect(commit.messageManifests).toEqual([{ chatId: "chat-a", ids: ["m-0", "m-1"] }]);
    expect(commit.messages).toEqual([]);
  });

  it("uses transient canonical positions for the hydrated tail instead of local indexes", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    Object.defineProperty(chat.message[0], "_sqlPosition", { value: 3, enumerable: false });
    Object.defineProperty(chat.message[1], "_sqlPosition", { value: 4, enumerable: false });
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-4"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-4", position: 4 }),
    ]);
  });

  it("uses canonical positions after prepending an older page", () => {
    const db = fixtureDatabaseWithMessages(6);
    const chat = db.characters[0].chats[0];
    chat.message = [chat.message[1], chat.message[2], chat.message[3], chat.message[4], chat.message[5]];
    chat.messagesFullyLoaded = false;
    for (const [index, message] of chat.message.entries()) {
      Object.defineProperty(message, "_sqlPosition", { value: index + 1, enumerable: false });
    }
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-1"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-1", position: 1 }),
    ]);
  });

  it("allocates a canonical position for a newly appended tail message", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    Object.defineProperty(chat, "_sqlWindow", { value: { hasOlder: true, nextPosition: 9 }, enumerable: false });
    Object.defineProperty(chat.message[0], "_sqlPosition", { value: 4, enumerable: false });
    Object.defineProperty(chat.message[1], "_sqlPosition", { value: 8, enumerable: false });
    chat.message.push({ chatId: "m-new", role: "char", data: "new" });
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-new"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-new", position: 9 }),
    ]);
    expect((chat.message[2] as any)._sqlPosition).toBe(9);
  });

  it("uses a parent chat manifest when a dirty chat has been deleted", () => {
    const db = fixtureDatabaseWithMessages(1);
    db.characters[0].chats = [];
    const dirty = cleanDirty();
    dirty.chats = [{ characterId: "character-a", chatId: "chat-a", manifest: true }];

    expect(buildSqlDirtyCommit(db, dirty, 7).chatManifests).toEqual([
      { characterId: "character-a", ids: [] },
    ]);
  });

  it("emits explicit character deletions instead of dropping a missing dirty character", () => {
    const db = fixtureDatabaseWithMessages(1);
    db.characters = [];
    const dirty = cleanDirty();
    dirty.characterIds = ["character-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).characterDeletes).toEqual(["character-a"]);
  });

  it("preserves preset order and active selection while upserting only marked presets", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [{ id: "preset-a", position: 1, data: db.botPresets[1] }],
      deletes: [],
      order: ["preset-b", "preset-a"],
      activeId: "preset-a",
    });
  });

  it("never emits a deletion manifest for an incomplete message window", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    const dirty = cleanDirty();
    dirty.messageManifestChatIds = ["chat-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).messageManifests).toEqual([]);
  });
});
