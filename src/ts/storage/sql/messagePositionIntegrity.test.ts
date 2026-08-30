import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import schema from "./sqlite-schema.sql?raw";
import { applySqliteCommit } from "./sqliteCommit";
import { buildSqlReplaceCommit, createEmptySqlCommit } from "./sqlCommit";
import {
  DUPLICATE_MESSAGE_POSITION_SQL,
  checkMessagePositionIntegrity,
  describeDuplicateMessagePositions,
} from "./messagePositionIntegrity";

/**
 * The evidence behind the "no UNIQUE (chat_id, position)" decision, kept
 * executable. Everything here runs the real schema and the real commit
 * applier against a real SQLite database -- an assertion about what SQLite
 * does is worthless unless SQLite is the thing being asked.
 */

const UNIQUE_INDEX =
  "CREATE UNIQUE INDEX messages_chat_position_unique ON messages (chat_id, position)";

function legacyDatabase(messageCount: number) {
  return {
    characters: [
      {
        chaId: "character-1",
        name: "Character",
        chats: [
          {
            id: "chat-1",
            name: "Chat",
            message: Array.from({ length: messageCount }, (_, index) => ({
              chatId: `message-${index + 1}`,
              role: index % 2 === 0 ? "user" : "char",
              data: `message ${index + 1}`,
            })),
          },
        ],
      },
    ],
  } as any;
}

function openDatabase(withUniqueIndex: boolean) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  if (withUniqueIndex) sqlite.exec(UNIQUE_INDEX);
  const execute = (sql: string, bind: unknown[] = []) => {
    sqlite.prepare(sql).run(...(bind as any[]));
  };
  const select = (sql: string) =>
    sqlite.prepare(sql).all() as Record<string, unknown>[];
  return { sqlite, execute, select };
}

/**
 * The statements the writer emits for a mid-chat deletion, in the order
 * `applySqliteCommit` emits them: the surviving messages are upserted at their
 * new positions first, and the manifest DELETE that removes the deleted id runs
 * after every upsert.
 */
function deleteMiddleMessageCommit() {
  const commit = createEmptySqlCommit(1, "message");
  commit.messages.push({
    id: "message-3",
    chatId: "chat-1",
    position: 1,
    data: { role: "char", data: "message 3" },
  });
  commit.messageManifests.push({
    chatId: "chat-1",
    ids: ["message-1", "message-3"],
  });
  return commit;
}

/** Inserting a message into the middle: later messages shift UP. */
function insertMiddleMessageCommit() {
  const commit = createEmptySqlCommit(1, "message");
  commit.messages.push({
    id: "message-new",
    chatId: "chat-1",
    position: 1,
    data: { role: "user", data: "inserted" },
  });
  commit.messages.push({
    id: "message-2",
    chatId: "chat-1",
    position: 2,
    data: { role: "char", data: "message 2" },
  });
  commit.messages.push({
    id: "message-3",
    chatId: "chat-1",
    position: 3,
    data: { role: "user", data: "message 3" },
  });
  commit.messageManifests.push({
    chatId: "chat-1",
    ids: ["message-1", "message-new", "message-2", "message-3"],
  });
  return commit;
}

describe("UNIQUE (chat_id, position) cannot be added", () => {
  it("would abort a mid-chat deletion, which the current schema handles", async () => {
    const guarded = openDatabase(true);
    guarded.sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), guarded.execute);
    guarded.sqlite.exec("COMMIT");

    guarded.sqlite.exec("BEGIN");
    await expect(
      applySqliteCommit(deleteMiddleMessageCommit(), guarded.execute),
    ).rejects.toThrow(/UNIQUE constraint failed: messages\.chat_id, messages\.position/);
    guarded.sqlite.exec("ROLLBACK");
    guarded.sqlite.close();

    // The same commit against the schema as shipped.
    const plain = openDatabase(false);
    plain.sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), plain.execute);
    await applySqliteCommit(deleteMiddleMessageCommit(), plain.execute);
    plain.sqlite.exec("COMMIT");

    expect(
      plain.sqlite
        .prepare("SELECT id, position FROM messages WHERE chat_id = ? ORDER BY position")
        .all("chat-1"),
    ).toEqual([
      { id: "message-1", position: 0 },
      { id: "message-3", position: 1 },
    ]);
    expect(checkMessagePositionIntegrity(plain.select)).toEqual([]);
    plain.sqlite.close();
  });

  it("would abort a mid-chat insertion no matter how the statements are ordered", async () => {
    const guarded = openDatabase(true);
    guarded.sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), guarded.execute);
    guarded.sqlite.exec("COMMIT");

    guarded.sqlite.exec("BEGIN");
    await expect(
      applySqliteCommit(insertMiddleMessageCommit(), guarded.execute),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    guarded.sqlite.exec("ROLLBACK");

    // Descending order is the fix for an insert -- and it is the case the
    // deletion test above already shows breaking, which is why no single
    // ordering works.
    const descending = insertMiddleMessageCommit();
    descending.messages.reverse();
    guarded.sqlite.exec("BEGIN");
    await applySqliteCommit(descending, guarded.execute);
    guarded.sqlite.exec("COMMIT");
    expect(
      guarded.sqlite
        .prepare("SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?")
        .get("chat-1"),
    ).toEqual({ total: 4 });
    guarded.sqlite.close();

    const plain = openDatabase(false);
    plain.sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), plain.execute);
    await applySqliteCommit(insertMiddleMessageCommit(), plain.execute);
    plain.sqlite.exec("COMMIT");
    expect(
      plain.sqlite
        .prepare("SELECT id FROM messages WHERE chat_id = ? ORDER BY position")
        .all("chat-1"),
    ).toEqual([
      { id: "message-1" },
      { id: "message-new" },
      { id: "message-2" },
      { id: "message-3" },
    ]);
    plain.sqlite.close();
  });

  it("rejects the canonical single-statement position shift too", () => {
    const { sqlite } = openDatabase(true);
    sqlite.prepare("INSERT INTO characters (id, position) VALUES ('c', 0)").run();
    sqlite
      .prepare("INSERT INTO chats (id, character_id, position) VALUES ('chat-1', 'c', 0)")
      .run();
    for (const [id, position] of [["a", 0], ["b", 1], ["c", 2]] as const) {
      sqlite
        .prepare("INSERT INTO messages (chat_id, id, position, role) VALUES (?, ?, ?, 'user')")
        .run("chat-1", id, position);
    }

    // SQLite has no deferrable UNIQUE, so even this raises mid-statement.
    expect(() =>
      sqlite
        .prepare("UPDATE messages SET position = position + 1 WHERE chat_id = ? AND position >= 1")
        .run("chat-1"),
    ).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });
});

describe("the check that guards the invariant instead", () => {
  it("finds nothing in a database the real writer produced", async () => {
    const { sqlite, execute, select } = openDatabase(false);
    sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(40), 0), execute);
    sqlite.exec("COMMIT");

    expect(checkMessagePositionIntegrity(select)).toEqual([]);
    sqlite.close();
  });

  it("names the affected chat when two messages share a position", async () => {
    const { sqlite, execute, select } = openDatabase(false);
    sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), execute);
    sqlite.exec("COMMIT");

    // The corruption the constraint would have caught: two rows, one slot.
    // Reproduced through the real table, not a stand-in.
    sqlite
      .prepare("UPDATE messages SET position = 0 WHERE chat_id = ? AND id = ?")
      .run("chat-1", "message-2");

    const report = vi.fn();
    const duplicates = checkMessagePositionIntegrity(select, report);

    expect(duplicates).toEqual([
      { chatId: "chat-1", position: 0, occurrences: 2 },
    ]);
    expect(report).toHaveBeenCalledOnce();
    const text = report.mock.calls[0][0] as string;
    expect(text).toContain("chat-1");
    expect(text).toContain("position 0");
    expect(text).toContain("Nothing was changed automatically");

    // The reason it matters: reading by position is now ambiguous.
    const paged = sqlite
      .prepare("SELECT id FROM messages WHERE chat_id = ? ORDER BY position LIMIT 2 OFFSET 0")
      .all("chat-1") as { id: string }[];
    expect(new Set(paged.map((row) => row.id)).size).toBe(2);
    expect(paged.map((row) => row.id)).not.toContain("message-3");
    sqlite.close();
  });

  it("reports rather than repairs", async () => {
    const { sqlite, execute, select } = openDatabase(false);
    sqlite.exec("BEGIN");
    await applySqliteCommit(buildSqlReplaceCommit(legacyDatabase(3), 0), execute);
    sqlite.exec("COMMIT");
    sqlite
      .prepare("UPDATE messages SET position = 0 WHERE chat_id = ? AND id = ?")
      .run("chat-1", "message-2");

    checkMessagePositionIntegrity(select, () => {});

    // Still three messages. A "repair" here would have to pick an order, and
    // picking wrong reorders someone's conversation permanently.
    expect(
      sqlite.prepare("SELECT COUNT(*) AS total FROM messages").get(),
    ).toEqual({ total: 3 });
    expect(checkMessagePositionIntegrity(select, () => {})).toHaveLength(1);
    sqlite.close();
  });

  it("throws rather than reporting a clean database when the query cannot run", () => {
    // "The check did not run" is unknown, not clean. Returning [] here is the
    // silent fallback the whole module exists to avoid.
    expect(() =>
      checkMessagePositionIntegrity(() => {
        throw new Error("no such table: messages");
      }),
    ).toThrow(/could not run[\s\S]*no such table: messages/);
  });

  it("uses the indexed grouping the messages table already has", () => {
    const { sqlite } = openDatabase(false);
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${DUPLICATE_MESSAGE_POSITION_SQL}`)
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "messages_chat_position_idx",
    );
    sqlite.close();
  });

  it("describes nothing when there is nothing to describe", () => {
    expect(describeDuplicateMessagePositions([])).toBe("");
  });
});
