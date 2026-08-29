import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteStorage } from "./nodeSqliteStorage";
import { buildSqlReplaceCommit } from "./sqlCommit";
import { applySqliteCommit } from "./sqliteCommit";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import type { Database } from "../database.svelte";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

/**
 * Legacy-to-SQL migration of a database that is merely NORMAL SIZED.
 *
 * A standalone user with a 50 MB `database.bin` re-downloads it and re-attempts
 * this migration on every single launch, because the migration is issued as one
 * `POST /api/sql/commit` whose statement array is larger than the server's
 * per-commit cap. The server rejects it on the first line of
 * relational-sqlite.cjs `commit()`, `selectCanonicalDatabase` catches the
 * failure and deliberately keeps the legacy database usable, and nothing
 * anywhere says the migration failed. Measured in the field: 50 MB downloaded,
 * 54 MB uploaded, 4.1 minutes, every launch, for months.
 *
 * These tests drive the real path -- `buildSqlReplaceCommit` ->
 * `applySqliteCommit` -> the JSON transport -> the real `relational-sqlite.cjs`
 * `commit()` against a real temp `node:sqlite` database -- with no production
 * code stubbed, exactly like the neighbouring `nodeSqliteStorage.test.ts`.
 */

type ServerStorage = {
  databasePath: string;
  revision(): number;
  commit(payload: unknown): { revision: number };
  bootstrap(options?: unknown): unknown;
  loadChatMessages(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): { messages: unknown[]; total: number };
  checkpoint(): unknown;
  close(): void;
};

const roots: string[] = [];
const openStorages: ServerStorage[] = [];
afterEach(() => {
  // `buildSqlReplaceCommit` refuses to run while a root key is marked deferred,
  // and the registry is module-level state shared across this file.
  resetDeferredRootKeys();
  for (const storage of openStorages.splice(0)) storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createServer(prefix: string): ServerStorage {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const storage = createRelationalSqlite({ dataRoot: root }) as ServerStorage;
  openStorages.push(storage);
  return storage;
}

/**
 * The server's per-commit statement cap, read from the server's real behaviour
 * instead of copied into this test as a literal.
 *
 * `relational-sqlite.cjs` `commit()` checks `statements.length` BEFORE it opens
 * the transaction and BEFORE it compares revisions, so a probe carrying an
 * impossible `baseRevision` costs nothing and separates the two outcomes
 * cleanly: at or below the cap it fails with 'SQL revision conflict', above it
 * with 'SQL commit is too large'. Nothing is ever executed or written.
 *
 * Measuring it rather than importing it means the tests below follow the cap
 * wherever it moves -- raised, lowered, or extracted into a named constant --
 * and, unlike an imported constant, cannot go stale if `commit()` stops
 * consulting it.
 *
 * Returns the largest statement count `commit()` still accepts.
 */
function measureMaxStatementsPerCommit(server: ServerStorage): number {
  const filler = { sql: "DELETE FROM messages", bind: [] };
  const rejectedAsTooLarge = (count: number): boolean => {
    try {
      server.commit({
        baseRevision: -1,
        action: "statement-cap-probe",
        statements: new Array(count).fill(filler),
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "SQL commit is too large") return true;
      if (message === "SQL revision conflict") return false;
      throw error;
    }
    throw new Error(
      `The statement-cap probe committed ${count} statements: baseRevision -1 no longer conflicts, ` +
      "so this probe can no longer measure the cap without writing to the database.",
    );
  };

  // Ceiling on the search so a cap that has been removed entirely fails loudly
  // and quickly instead of allocating until the process dies.
  const SEARCH_LIMIT = 8_000_000;
  let rejected = 1;
  while (!rejectedAsTooLarge(rejected)) {
    rejected *= 2;
    if (rejected > SEARCH_LIMIT) {
      throw new Error(
        `relational-sqlite commit() accepted ${SEARCH_LIMIT} statements: no per-commit cap found.`,
      );
    }
  }
  let accepted = rejected === 1 ? 0 : rejected / 2;
  while (rejected - accepted > 1) {
    const middle = Math.floor((accepted + rejected) / 2);
    if (rejectedAsTooLarge(middle)) rejected = middle;
    else accepted = middle;
  }
  return accepted;
}

/**
 * A legacy in-memory `Database` of the shape the legacy `database.bin` holds.
 *
 * Message bodies are deliberately short. Statement count is driven by the
 * NUMBER of messages, not their length, so a short body builds the cheapest
 * fixture that still reproduces the failure; a field-sized 50 MB database
 * produces the same statements with more text bound into them.
 */
function buildLegacyDatabase(
  characters: number,
  chatsPerCharacter: number,
  messagesPerChat: number,
): Database {
  return {
    username: "Migrating User",
    pluginCustomStorage: {},
    botPresets: [{ id: "preset-1", name: "Default" }],
    botPresetsId: 0,
    characters: Array.from({ length: characters }, (_, characterIndex) => ({
      chaId: `character-${characterIndex}`,
      name: `Character ${characterIndex}`,
      chats: Array.from({ length: chatsPerCharacter }, (_, chatIndex) => ({
        id: `character-${characterIndex}-chat-${chatIndex}`,
        name: `Chat ${chatIndex}`,
        message: Array.from({ length: messagesPerChat }, (_, messageIndex) => ({
          chatId: `character-${characterIndex}-chat-${chatIndex}-message-${messageIndex}`,
          role: messageIndex % 2 === 0 ? "user" : "char",
          data: `message ${messageIndex} of a perfectly ordinary chat log`,
        })),
      })),
    })),
  } as unknown as Database;
}

/**
 * The statements one legacy-to-SQL migration of `database` produces, counted
 * through the real builders. The four leading DELETEs mirror what
 * `NodeSqliteStorage.commit()` prepends for a `replaceAll`.
 */
async function countMigrationStatements(database: Database): Promise<number> {
  const commit = buildSqlReplaceCommit(database, 0);
  let statements = 4;
  await applySqliteCommit(commit, () => {
    statements++;
  });
  return statements;
}

describe("legacy-to-SQL migration of a large database", () => {
  it("names the real boundary: one commit cannot carry an ordinary chat history", async () => {
    const maxStatementsPerCommit = measureMaxStatementsPerCommit(
      createServer("risu-migration-cap-"),
    );
    expect(maxStatementsPerCommit).toBeGreaterThan(0);

    // A small, precisely-sized sample: 4 characters x 5 chats x 200 messages.
    const messages = 4 * 5 * 200;
    const statements = await countMigrationStatements(buildLegacyDatabase(4, 5, 200));

    // Statement cost is per message and roughly constant: one INSERT into
    // `messages`, one DELETE of its extension nodes, and one row per node of
    // the flattened message object.
    const statementsPerMessage = statements / messages;
    expect(statementsPerMessage).toBeGreaterThan(4);
    expect(statementsPerMessage).toBeLessThan(8);

    // The number this bug is really about: how much history fits in ONE commit.
    // A single request tops out around 50,000 messages, which real users pass
    // long before their database is remarkable.
    const messagesThatFitInOneCommit = Math.floor(
      maxStatementsPerCommit / statementsPerMessage,
    );
    expect(messagesThatFitInOneCommit).toBeLessThan(100_000);

    // ...and a database above that ceiling cannot be migrated by one commit at
    // all. Sized from the measured cap, so this follows the cap if it moves.
    const oversized = buildLegacyDatabase(
      20,
      6,
      Math.ceil((maxStatementsPerCommit * 1.06) / (20 * 6 * statementsPerMessage)),
    );
    expect(await countMigrationStatements(oversized)).toBeGreaterThan(
      maxStatementsPerCommit,
    );
  });

  it("migrates a legacy database larger than one commit into SQL", async () => {
    const server = createServer("risu-migration-large-");
    const maxStatementsPerCommit = measureMaxStatementsPerCommit(server);

    const CHARACTERS = 20;
    const CHATS_PER_CHARACTER = 6;
    const STATEMENTS_PER_MESSAGE = 5;
    // Sized from the measured cap with a small margin, so the fixture stays the
    // smallest one that still crosses the cap and re-sizes itself if the cap
    // moves. ~53,000 messages / ~266,000 statements / ~4.4 MB of legacy JSON.
    const messagesPerChat = Math.ceil(
      (maxStatementsPerCommit * 1.06) /
      (CHARACTERS * CHATS_PER_CHARACTER * STATEMENTS_PER_MESSAGE),
    );
    const totalMessages = CHARACTERS * CHATS_PER_CHARACTER * messagesPerChat;
    const source = buildLegacyDatabase(CHARACTERS, CHATS_PER_CHARACTER, messagesPerChat);

    // The fixture must actually cross the cap, or everything below passes for
    // the wrong reason.
    const statements = await countMigrationStatements(source);
    expect(statements).toBeGreaterThan(maxStatementsPerCommit);

    // The real client, over a transport that mirrors the real route:
    // `POST /api/sql/commit` -> `relationalSql.commit(req.body)`, 409 on a
    // revision conflict, and everything else handed to server.cjs's error
    // middleware, which answers 500 with the message in the body -- a message
    // `sendStatements` discards. `rejections` keeps it so a failure here can
    // say what the server actually refused, which the product cannot.
    const rejections: string[] = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      // The migration checks what it wrote against what its source described
      // before it calls itself finished, and it reads the stored counts from
      // `bootstrap()`. Answering it here is the same route the real server has.
      if (path.startsWith("/api/sql/bootstrap")) {
        const defer = new URL(path, "https://risu.invalid").searchParams.get("defer");
        return Response.json(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
      }
      if (path !== "/api/sql/commit") throw new Error(`unexpected request: ${path}`);
      try {
        return Response.json(server.commit(JSON.parse(String(init?.body))));
      } catch (error: any) {
        if (error?.code === "SQL_REVISION_CONFLICT") {
          return Response.json({ currentRevision: error.currentRevision }, { status: 409 });
        }
        rejections.push(String(error?.message));
        return Response.json({ error: String(error?.message) }, { status: 500 });
      }
    };
    const client = new NodeSqliteStorage(request);

    try {
      expect(await client.replaceDatabase(source)).toBe(true);
    } catch (error) {
      throw new Error(
        `Migrating ${statements} statements (${totalMessages} messages, ` +
        `cap ${maxStatementsPerCommit}) failed: ${(error as Error).message}` +
        (rejections.length ? ` -- server refused it: ${rejections.join("; ")}` : ""),
      );
    }
    expect(rejections).toEqual([]);

    // The migration is only real if it landed in the file on disk AND the
    // database is marked initialized: `system_storage_meta.initialized` is what
    // says "this SQL database is canonical", and a partially applied migration
    // recorded as a finished one is the failure mode this project refuses to
    // ship.
    server.checkpoint();
    const inspector = new DatabaseSync(server.databasePath);
    try {
      const meta = inspector
        .prepare("SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1")
        .get() as { initialized: number; revision: number };
      expect(Number(meta.initialized)).toBe(1);
      expect(Number(meta.revision)).toBeGreaterThan(0);

      const count = (table: string) =>
        Number((inspector.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total);
      expect(count("characters")).toBe(CHARACTERS);
      expect(count("chats")).toBe(CHARACTERS * CHATS_PER_CHARACTER);
      expect(count("messages")).toBe(totalMessages);
    } finally {
      inspector.close();
    }

    // ...and the server can read the migrated history back through its own API.
    const page = server.loadChatMessages("character-0-chat-0", undefined, 5);
    expect(page.total).toBe(messagesPerChat);
    expect(page.messages).toHaveLength(5);
  }, 300_000);
});
