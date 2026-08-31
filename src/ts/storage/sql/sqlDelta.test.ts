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

  it("keeps canonical message rows when residency trimming released the newest end", () => {
    // The mirror of the case below, and the one trimming actually produces:
    // nothing older is left to load, but the newest end was released. The
    // runtime flags are left saying "loaded" so this pins the window predicate
    // itself; a writer still asking `hasOlderSqlMessages` sees "complete" and
    // rewrites the manifest from a slice that is missing the end of the chat,
    // which turns every released message into a deletion.
    const before = database();
    const after = structuredClone(before);
    after.characters[0].chats[0].message = [after.characters[0].chats[0].message[0]];
    after.characters[0].chats[0].name = "Renamed while trimmed";
    after.characters[0].chats[0].messagesLoaded = true;
    after.characters[0].chats[0].messagesFullyLoaded = true;
    setSqlWindow(after.characters[0].chats[0], {
      before: null, nextBefore: null, total: 2, hasOlder: false, hasNewer: true, nextAfter: 0, nextPosition: 2,
    });

    const commit = buildSqlDeltaCommit(before, after, 3)!;

    expect(commit.chats).toEqual([expect.objectContaining({ id: "chat-1" })]);
    expect(commit.messages).toEqual([]);
    expect(commit.messageManifests).toEqual([]);
  });

  it("keeps canonical message rows when the current chat is only a partial SQL window", () => {
    const before = database();
    const after = structuredClone(before);
    after.characters[0].chats[0].message = [after.characters[0].chats[0].message[1]];
    after.characters[0].chats[0].name = "Renamed while windowed";
    after.characters[0].chats[0].messagesLoaded = true;
    after.characters[0].chats[0].messagesFullyLoaded = false;
    setSqlWindow(after.characters[0].chats[0], {
      before: null, nextBefore: 0, total: 2, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 2,
    });

    const commit = buildSqlDeltaCommit(before, after, 3)!;

    expect(commit.chats).toEqual([expect.objectContaining({ id: "chat-1" })]);
    expect(commit.messages).toEqual([]);
    expect(commit.messageManifests).toEqual([]);
  });
});

/**
 * The delta builder compares values by encoding them, so it has to encode them
 * the same way the write path does. It used to call `flattenRelationalValue`
 * directly, which throws above the row cap -- so on a value large enough to be
 * stored as a single JSON row, asking "did this setting change?" threw instead
 * of answering, and took the whole sync with it.
 *
 * (`buildSqlDeltaCommit` has no production caller today: `sqlDelta.ts` is
 * imported only by this file. The invariant is still worth pinning, because the
 * two encoders silently disagreeing is exactly the shape of the bug this
 * replaced.)
 */
describe("comparing a value too large to explode into one row per scalar", () => {
  function bigModules(entries: number) {
    return [{
      id: "module-one",
      name: "One",
      lorebook: Array.from({ length: entries }, (_unused, index) => ({
        key: `key-${index}`,
        content: `content ${index}`,
        insertorder: index,
      })),
    }];
  }

  it("answers instead of throwing, and still sees the change", () => {
    // Past MAX_RELATIONAL_NODE_ROWS: roughly four nodes per entry.
    const before = { ...database(), modules: bigModules(70_000) };
    const after = { ...database(), modules: bigModules(70_001) };

    const commit = buildSqlDeltaCommit(before as any, after as any, 3)!;

    expect(commit.root.upserts.map((upsert) => upsert.key)).toContain("modules");
  });

  it("reports no change when such a value is untouched", () => {
    const before = { ...database(), modules: bigModules(70_000) };
    const after = { ...database(), modules: bigModules(70_000) };

    // Nothing at all changed, so there is no commit to make -- and reaching
    // that answer means the comparison completed rather than throwing.
    expect(buildSqlDeltaCommit(before as any, after as any, 3)).toBeNull();
  });
});
