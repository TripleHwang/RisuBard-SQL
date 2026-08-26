import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import schema from "./sqlite-schema.sql?raw";
import { rebuildRelationalValue } from "./relationalNodeCodec";
import { applySqliteCommit } from "./sqliteCommit";
import { buildSqlReplaceCommit, createEmptySqlCommit } from "./sqlCommit";

describe("SQLite relational integration", () => {
  it("executes the schema and round-trips legacy extension values", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(schema);
    const execute = (sql: string, bind: unknown[] = []) => {
      sqlite.prepare(sql).run(...(bind as any[]));
    };
    const source = {
      username: "User\0Name",
      customRoot: {
        finite: 3.5,
        nan: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
        missing: undefined,
        surrogate: "\ud800",
      },
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
              ],
            },
          ],
        },
      ],
    } as any;

    sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(source, 0), execute);
    sqlite.exec("COMMIT");

    const settingRows = sqlite
      .prepare(
        `SELECT node_id, parent_node_id, node_order, object_key,
          object_key_encoded, value_type, text_value, encoded_text_value,
          number_value, boolean_value
         FROM setting_extension_nodes
         WHERE setting_key = ? ORDER BY node_id`,
      )
      .all("customRoot") as any[];
    expect(rebuildRelationalValue(settingRows)).toEqual(source.customRoot);

    const messageRows = sqlite
      .prepare(
        `SELECT node_id, parent_node_id, node_order, object_key,
          object_key_encoded, value_type, text_value, encoded_text_value,
          number_value, boolean_value
         FROM message_extension_nodes
         WHERE chat_id = ? AND message_id = ? ORDER BY node_id`,
      )
      .all("chat-1", "message-1") as any[];
    expect(rebuildRelationalValue(messageRows)).toEqual({
      role: "user",
      data: "hello",
    });

    const plugin = sqlite
      .prepare("SELECT value FROM plugin_custom_storage WHERE key = ?")
      .get("pagefold.config.v1") as { value: string };
    expect(JSON.parse(plugin.value)).toEqual({ provider: "google" });

    const replacement = {
      ...source,
      pluginCustomStorage: { "only-new": { provider: "local" } },
    };
    await applySqliteCommit(buildSqlReplaceCommit(replacement, 1), execute);
    expect(
      sqlite.prepare("SELECT key FROM plugin_custom_storage ORDER BY key").all(),
    ).toEqual([{ key: "only-new" }]);

    const edit = createEmptySqlCommit(1, "message");
    edit.messages.push({
      id: "message-1",
      chatId: "chat-1",
      position: 0,
      data: { role: "char", data: "edited" },
    });
    await applySqliteCommit(edit, execute);
    expect(
      sqlite
        .prepare("SELECT role FROM messages WHERE chat_id = ? AND id = ?")
        .get("chat-1", "message-1"),
    ).toEqual({ role: "char" });

    sqlite.close();
  });
});
