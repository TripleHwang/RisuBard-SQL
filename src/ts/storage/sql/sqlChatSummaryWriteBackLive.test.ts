// @vitest-environment node
/**
 * A dirty flush must never destroy the settings of a chat nobody has opened.
 *
 * The assertion is made against the SQLite file itself, deliberately, and using
 * nothing but the APIs that existed before the chat-detail read did: boot,
 * `markSqlChatDirty`, `flushSqlDirtyChanges`, and a direct read of
 * `chat_extension_nodes`. That is what makes it a regression test rather than a
 * test of the new code -- it fails on the build that has no read path, and it
 * fails by showing the rows GONE, not merely unread.
 *
 * The mechanism: the bootstrap ships chats as `summaryChat()` -- `name`,
 * `note`, `folderId`, `lastDate`, the four real columns on `chats`. Everything
 * else on the `Chat` shape is in `chat_extension_nodes`. Nothing read those
 * nodes back, so the in-memory chat never held them, so `sqlChatData()`
 * serialised a chat without them -- and `replaceNodes` DELETEs a chat's whole
 * node set before inserting what it is given. One flush, and the per-chat
 * lorebook, the alternate-greeting index and every binding were gone from
 * storage.
 *
 * Nothing in the running app has to go wrong for the flush to happen: the idle
 * compatibility audit marks chats dirty from a whole-database diff, so a chat
 * the user never opened is written back the first time anything looks changed.
 */
import { proxy } from "svelte/internal/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database, character } from "../database.svelte";

const nodeGlobal = globalThis as Record<string, unknown>;
nodeGlobal.window ??= { matchMedia: () => ({ matches: false }), addEventListener: () => {} };
nodeGlobal.document ??= { referrer: "" };
nodeGlobal.navigator ??= {};

const { publishLiveDatabase, resetLiveDatabaseForTesting } = await import("./liveDatabase");
const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { openExistingStandaloneSql, setActiveSqlStorageForTesting } = await import("./sqlBootstrap");
const {
  flushSqlDirtyChanges,
  markSqlChatDirty,
  resetSqlPersistenceRuntimeForTesting,
} = await import("./sqlPersistenceRuntime");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

const CHARACTER_ID = "character-summary-writeback";
const CHAT_ID = "chat-summary-writeback";

let server: ServerHandle;

function legacyDatabase(): Database {
  return {
    apiType: "openai",
    username: "name at boot",
    maxContext: 4000,
    personas: [{ name: "Default", icon: "", personaPrompt: "" }],
    botPresets: [],
    botPresetsId: 0,
    modules: [],
    pluginCustomStorage: {},
    characters: [{
      chaId: CHARACTER_ID,
      type: "character",
      name: "Ada",
      image: "",
      desc: "",
      firstMessage: "Hello, this is the greeting.",
      alternateGreetings: ["second greeting", "third greeting"],
      chatPage: 0,
      chats: [{
        id: CHAT_ID,
        name: "Chat 0",
        note: "",
        fmIndex: 2,
        bindedPersona: "persona-the-user-picked",
        localLore: [{ key: "per-chat-lore-key", content: "only this chat knows this" }],
        message: [
          { role: "user", data: "message 0", chatId: `${CHAT_ID}-msg-000` },
          { role: "char", data: "message 1", chatId: `${CHAT_ID}-msg-001` },
        ],
      }],
    }],
  } as unknown as Database;
}

/**
 * The `object_key`s stored under this chat, read straight out of the file.
 *
 * A key present here is a field storage actually holds. This deliberately does
 * not go through any read API: the point is what is on disk.
 */
async function storedChatKeys(): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const database = new DatabaseSync(join(server.cwd, "save", "sql", "risu-standalone.sqlite3"));
  try {
    const rows = database.prepare(
      "SELECT object_key FROM chat_extension_nodes WHERE chat_id = ? AND object_key IS NOT NULL",
    ).all(CHAT_ID) as Array<{ object_key: string }>;
    return rows.map((row) => row.object_key).sort();
  } finally {
    database.close();
  }
}

describe("a flush that marks an unopened chat dirty", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    const storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase())).toBe(true);
    // The migration really did store them. Without this the test below could
    // pass over a database that never had the fields in the first place.
    expect(await storedChatKeys()).toEqual(
      expect.arrayContaining(["bindedPersona", "fmIndex", "localLore"]),
    );
  }, 60_000);

  afterAll(async () => {
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetLiveDatabaseForTesting();
    await server?.cleanup();
  });

  it("does not delete the settings of a chat that is still a bootstrap summary", async () => {
    resetSqlPersistenceRuntimeForTesting();
    const client = await createClient(server.port, server.password);
    const storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);

    const holder = { db: {} as Database };
    publishLiveDatabase(() => holder.db);
    const opened = await openExistingStandaloneSql(storage);
    expect(opened?.usingSql).toBe(true);
    holder.db = proxy(opened!.database);

    const live = holder.db.characters[0] as unknown as character;
    const summary = live.chats[0] as typeof live.chats[0] & { detailsLoaded?: boolean };
    // The precondition of the whole defect: the client holds a summary, and it
    // does not have the fields storage holds.
    expect(summary.detailsLoaded).toBe(false);
    expect(summary.bindedPersona).toBeUndefined();
    expect(summary.localLore).toBeUndefined();

    markSqlChatDirty(CHARACTER_ID, CHAT_ID);
    await flushSqlDirtyChanges();

    expect(await storedChatKeys()).toEqual(
      expect.arrayContaining(["bindedPersona", "fmIndex", "localLore"]),
    );
  }, 60_000);
});
