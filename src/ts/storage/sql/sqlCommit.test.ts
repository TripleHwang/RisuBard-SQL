import { describe, expect, it } from "vitest";

import { applySqliteCommit } from "./sqliteCommit";
import {
  buildSqlReplaceCommit,
  createEmptySqlCommit,
  hasSqlCommitChanges,
} from "./sqlCommit";

describe("RisuVault SQL row commits", () => {
  it("splits legacy snapshots into character, chat and message rows", () => {
    const database = {
      username: "User",
      pluginCustomStorage: { pagefold: { packagingMode: "maximum" } },
      botPresets: [],
      botPresetsId: 0,
      characters: [
        {
          chaId: "character-1",
          type: "character",
          name: "Character",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: [{ chatId: "message-1", role: "user", data: "hello" }],
            },
          ],
        },
      ],
    } as any;

    const commit = buildSqlReplaceCommit(database, 7);

    expect(commit.baseRevision).toBe(7);
    expect(commit.replaceAll).toBe(true);
    expect(commit.root.upserts).toEqual([{ key: "username", value: "User" }]);
    expect(commit.pluginStorage?.upserts).toEqual([
      { key: "pagefold", value: { packagingMode: "maximum" } },
    ]);
    expect(commit.characters[0].data).not.toHaveProperty("chats");
    expect(commit.chats[0].data).not.toHaveProperty("message");
    expect(commit.chats[0].data).not.toHaveProperty("messagesLoaded");
    expect(commit.chats[0].data).not.toHaveProperty("_sqlWindow");
    expect(commit.messages).toEqual([
      {
        id: "message-1",
        chatId: "chat-1",
        position: 0,
        data: { role: "user", data: "hello" },
      },
    ]);
  });

  it("does not serialize runtime SQL message windows", () => {
    const database = {
      characters: [{ chaId: "character-1", chats: [{ id: "chat-1", message: [], _sqlWindow: { total: 10 } }] }],
      botPresets: [], botPresetsId: 0,
    } as any;
    expect(buildSqlReplaceCommit(database, 0).chats[0].data).not.toHaveProperty("_sqlWindow");
  });

  it("keeps normal commits bounded to the changed rows", async () => {
    const commit = createEmptySqlCommit(2, "message");
    expect(hasSqlCommitChanges(commit)).toBe(false);

    commit.root.upserts.push({ key: "temperature", value: 80 });
    commit.messages.push({
      id: "message-1",
      chatId: "chat-1",
      position: 4,
      data: { role: "char", data: "answer" },
    });
    expect(hasSqlCommitChanges(commit)).toBe(true);

    const statements: { sql: string; bind: unknown[] }[] = [];
    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements.some(({ sql }) => sql.includes("system_settings"))).toBe(
      true,
    );
    expect(statements.some(({ sql }) => sql.includes("messages"))).toBe(true);
    expect(
      statements.every(({ sql }) => !sql.includes("DELETE FROM characters")),
    ).toBe(true);
  });

  it("writes plugin state only through the explicit JSON exception", async () => {
    const commit = createEmptySqlCommit(1);
    commit.pluginStorage = {
      upserts: [{ key: "pagefold.config.v1", value: { activeProvider: "google" } }],
      deletes: [],
    };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const statement = statements.find(({ sql }) =>
      sql.includes("INSERT INTO plugin_custom_storage"),
    );
    expect(statement?.bind).toEqual([
      "pagefold.config.v1",
      JSON.stringify({ activeProvider: "google" }),
    ]);
  });

  it("deletes only explicitly named character rows", async () => {
    const commit = createEmptySqlCommit(1);
    commit.characterDeletes = ["character-removed"];
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toContainEqual({
      sql: "DELETE FROM characters WHERE id IN (?)",
      bind: ["character-removed"],
    });
  });

  it("uses a preset manifest to remove absent presets and clear the active setting", async () => {
    const commit = createEmptySqlCommit(1);
    commit.presets = { upserts: [], deletes: [], order: [], activeId: null, manifest: true };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toContainEqual({ sql: "DELETE FROM bot_presets", bind: [] });
    expect(statements).toContainEqual({ sql: "DELETE FROM system_settings WHERE key = ?", bind: ["activeBotPresetId"] });
  });

  it("generates stable ids for legacy chats and messages that lack them", () => {
    const database = {
      characters: [{ chaId: "character-1", name: "C", chats: [{ message: [{ role: "char", data: "A" }] }] }],
      botPresets: [],
      botPresetsId: 0,
    } as any;
    const commit = buildSqlReplaceCommit(database, 0);
    expect(commit.chats[0].id).toBeTruthy();
    expect(commit.messages[0].id).toBeTruthy();
    expect(database.characters[0].chats[0].id).toBe(commit.chats[0].id);
    expect(database.characters[0].chats[0].message[0].chatId).toBe(
      commit.messages[0].id,
    );
  });
});
