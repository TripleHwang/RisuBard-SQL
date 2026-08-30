import { describe, expect, it, vi } from "vitest";

import type { DirtySnapshot } from "./dirtyRegistry";
import { buildSqlDirtyCommit } from "./sqlDirtyCommit";
import { getSqlPosition, setSqlPosition, setSqlWindow } from "./sqlRuntimeWindow";

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
    setSqlPosition(chat.message[0], 3);
    setSqlPosition(chat.message[1], 4);
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
      setSqlPosition(message, index + 1);
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
    setSqlWindow(chat, { before: null, nextBefore: 4, total: 5, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 9 });
    setSqlPosition(chat.message[0], 4);
    setSqlPosition(chat.message[1], 8);
    chat.message.push({ chatId: "m-new", role: "char", data: "new" });
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-new"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-new", position: 9 }),
    ]);
    expect(getSqlPosition(chat.message[2])).toBe(9);
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

  it("keeps a per-ID preset update row-scoped", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [{ id: "preset-a", position: 1, data: db.botPresets[1] }],
      deletes: [],
    });
  });

  it("reconciles the complete preset list only when the list root is dirty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresets"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [
        { id: "preset-b", position: 0, data: db.botPresets[0] },
        { id: "preset-a", position: 1, data: db.botPresets[1] },
      ],
      deletes: [],
      order: ["preset-b", "preset-a"],
      activeId: "preset-a",
      manifest: true,
    });
  });

  it("clears the preset manifest and active selection when the list is replaced with empty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [];
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresets"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: [], order: [], activeId: null, manifest: true,
    });
  });

  it("writes only the selected preset when the active preset root is dirty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-a", name: "A" }, { id: "preset-b", name: "B" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresetsId"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: [], activeId: "preset-b",
    });
  });

  it("moves active selection while deleting a marked preset without rewriting order", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }];
    db.botPresetsId = 0;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-a"], activeId: "preset-b",
    });
  });

  it("clears active selection while deleting the last marked preset", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [];
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-a"], activeId: null,
    });
  });

  it("preserves the current active selection while deleting a non-active marked preset", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-a", name: "A" }];
    db.botPresetsId = 0;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-b"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-b"], activeId: "preset-a",
    });
  });

  it("never emits a deletion manifest after residency trimming released the newest end", () => {
    // What trimming actually leaves behind: nothing older to load, the newest
    // end released. `messagesFullyLoaded` is left true on purpose so this pins
    // the window predicate rather than passing on the flag trimming also
    // clears. A gate still asking `hasOlderSqlMessages` rewrites the manifest
    // from the resident slice, and every released message becomes a DELETE
    // against a row still on disk.
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(0, 2);
    chat.messagesLoaded = true;
    chat.messagesFullyLoaded = true;
    setSqlWindow(chat, {
      before: null, nextBefore: null, total: 5, hasOlder: false, hasNewer: true, nextAfter: 1, nextPosition: 5,
    });
    const dirty = cleanDirty();
    dirty.messageManifestChatIds = ["chat-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).messageManifests).toEqual([]);
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

describe("a character that is still a bootstrap summary", () => {
  // The summary carries name, image, chat list and timestamps -- and no
  // description, first message, lorebook or scripts. Writing one back replaces
  // the stored record with it. This is reachable on an ordinary launch:
  // auditSqlCompatibilityDatabase marks EVERY character dirty when the
  // character order changes, summaries included, so a user who reorders loses
  // everything but the name of each character they had not opened yet.
  const summaryDatabase = () => ({
    characters: [{
      chaId: "character-1",
      name: "Alice",
      image: "assets/alice.png",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    }],
    botPresets: [],
    pluginCustomStorage: {},
  }) as any;

  it("is never written back over the stored record", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const commit = buildSqlDirtyCommit(summaryDatabase(), {
      ...cleanDirty(), characterIds: ["character-1"],
    }, 1);

    expect(commit.characters).toEqual([]);
    expect(commit.characterDeletes ?? []).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is written normally once it has been hydrated", () => {
    const database = summaryDatabase();
    database.characters[0].detailsLoaded = true;
    database.characters[0].desc = "the description the summary does not carry";

    const commit = buildSqlDirtyCommit(database, {
      ...cleanDirty(), characterIds: ["character-1"],
    }, 1);

    expect(commit.characters).toHaveLength(1);
    expect((commit.characters[0].data as any).desc).toBe("the description the summary does not carry");
  });
});

describe("a chat that is still a bootstrap summary", () => {
  // The summary carries name, note, folder and last message time -- the four
  // real columns on `chats` -- and none of the per-chat settings, which all
  // live in `chat_extension_nodes`. `replaceNodes` DELETEs a chat's whole node
  // set before inserting what it is given, so writing a summary does not fail
  // to update those fields, it destroys them: the lorebook, the alternate
  // greeting index, the persona/preset bindings, the memory data, the script
  // state. Reachable without the user opening the chat at all, because the idle
  // compatibility audit marks chats dirty from a whole-database diff.
  const summaryDatabase = () => ({
    characters: [{
      chaId: "character-1",
      name: "Alice",
      chatPage: 0,
      chats: [{
        id: "chat-1",
        name: "Chat 0",
        note: "",
        message: [],
        messagesLoaded: false,
        detailsLoaded: false,
      }],
    }],
    botPresets: [],
    pluginCustomStorage: {},
  }) as any;

  const dirtyChat = () => ({
    ...cleanDirty(),
    chats: [{ characterId: "character-1", chatId: "chat-1", manifest: false }],
  });

  it("is never written back over the stored settings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const commit = buildSqlDirtyCommit(summaryDatabase(), dirtyChat(), 1);

    expect(commit.chats).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is reported to the caller so the mark can be retained and the chat loaded", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused: Array<[string, string]> = [];

    buildSqlDirtyCommit(summaryDatabase(), dirtyChat(), 1, undefined,
      (characterId, chatId) => { refused.push([characterId, chatId]); });

    expect(refused).toEqual([["character-1", "chat-1"]]);
    consoleError.mockRestore();
  });

  it("still records the parent character's chat manifest", () => {
    // The manifest is a fact about the character -- which chats it has, in what
    // order -- not about this chat's contents. Withholding it would let a real
    // creation, deletion or reorder go unrecorded because one unopened chat
    // happened to be in the same flush.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dirty = dirtyChat();
    dirty.chats[0].manifest = true;

    const commit = buildSqlDirtyCommit(summaryDatabase(), dirty, 1);

    expect(commit.chats).toEqual([]);
    expect(commit.chatManifests).toEqual([{ characterId: "character-1", ids: ["chat-1"] }]);
    consoleError.mockRestore();
  });

  it("is written normally once its own fields have been hydrated", () => {
    const database = summaryDatabase();
    database.characters[0].chats[0].detailsLoaded = true;
    database.characters[0].chats[0].bindedPersona = "the persona a summary does not carry";
    database.characters[0].chats[0].localLore = [{ key: "per-chat-lore" }];

    const commit = buildSqlDirtyCommit(database, dirtyChat(), 1);

    expect(commit.chats).toHaveLength(1);
    expect((commit.chats[0].data as any).bindedPersona).toBe("the persona a summary does not carry");
    expect((commit.chats[0].data as any).localLore).toEqual([{ key: "per-chat-lore" }]);
    // The marker itself is never stored; the server synthesises it per read.
    expect((commit.chats[0].data as any).detailsLoaded).toBeUndefined();
  });
});
