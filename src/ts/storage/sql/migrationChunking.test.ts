import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NodeSqliteStorage,
  SQL_MIGRATION_CHUNK_STATEMENTS,
  SQL_MIGRATION_MARKER_KEY,
} from "./nodeSqliteStorage";
import { selectCanonicalDatabase } from "./sqlBootstrap";
import { buildSqlReplaceCommit, createEmptySqlCommit } from "./sqlCommit";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import {
  describeSqlMigrationProgress,
  onSqlMigrationFailure,
  onSqlMigrationProgress,
  resetSqlMigrationListeners,
  type SqlMigrationFailure,
  type SqlMigrationProgress,
} from "./migrationReporting";
import type { Database } from "../database.svelte";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");
const { SQL_COMMIT_CONFLICT_CODES } = require("../../../../server/node/sql-commit-route.cjs");

/**
 * A legacy-to-SQL migration is no longer one request, and these tests drive the
 * real thing: `NodeSqliteStorage` over a transport that mirrors the real
 * `POST /api/sql/commit` route, against a real `relational-sqlite.cjs` database
 * in a temp directory. Nothing is stubbed except the HTTP hop itself.
 *
 * What is asserted here, in order:
 *   - a migration too big for one request is split, and every request stays
 *     within the client's own chunk size;
 *   - ordinary commits -- including deliberately large ones -- still go in a
 *     single request, so a normal save never pays for this and never loses its
 *     all-or-nothing transaction;
 *   - progress is reported as the migration advances;
 *   - a migration that dies midway is NOT mistaken for a finished one on the
 *     next launch, even though the server has already set
 *     `system_storage_meta.initialized = 1`;
 *   - a migration that fails is reported, while the legacy database stays
 *     canonical exactly as before.
 */

type ServerStorage = {
  databasePath: string;
  revision(): number;
  bootstrap(options?: unknown): unknown;
  dump(): unknown;
  commit(payload: unknown): { revision: number };
  checkpoint(): unknown;
  close(): void;
};

const roots: string[] = [];
const openStorages: ServerStorage[] = [];
afterEach(() => {
  // Both registries are module-level state shared across this file: a stale
  // deferral mark changes what `buildSqlReplaceCommit` will do, and a stale
  // listener would let one test observe another test's migration.
  resetDeferredRootKeys();
  resetSqlMigrationListeners();
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

interface CommitRequest {
  baseRevision: number;
  action: string;
  statements: { sql: string; bind: unknown[] }[];
}

interface Harness {
  server: ServerStorage;
  /** Every `POST /api/sql/commit` body the client sent, in order. */
  commits: CommitRequest[];
  /** Messages the server refused, which the 500 response body carries. */
  rejections: string[];
  newClient(): NodeSqliteStorage;
  /** Make the Nth (1-based) commit request fail like server.cjs's 500 handler. */
  failCommit(ordinal: number, message: string): void;
}

/**
 * A transport that mirrors the real routes: `/api/sql/bootstrap` (honouring
 * `?defer=`), `/api/sql/snapshot`, and `/api/sql/commit` answering 409 on a
 * revision conflict and otherwise 500 with the message in the body -- which is
 * what express's error middleware does today.
 */
function createHarness(prefix: string): Harness {
  const server = createServer(prefix);
  const commits: CommitRequest[] = [];
  const rejections: string[] = [];
  let failOrdinal = 0;
  let failMessage = "";

  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/sql/bootstrap")) {
      const defer = new URL(path, "https://risu.invalid").searchParams.get("defer");
      return Response.json(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
    }
    if (path === "/api/sql/snapshot") return Response.json(server.dump());
    if (path !== "/api/sql/commit") throw new Error(`unexpected request: ${path}`);
    const body = JSON.parse(String(init?.body)) as CommitRequest;
    commits.push(body);
    if (commits.length === failOrdinal) {
      rejections.push(failMessage);
      return Response.json({ error: failMessage }, { status: 500 });
    }
    try {
      return Response.json(server.commit(body));
    } catch (error: any) {
      // Mirrors server/node/sql-commit-route.cjs, not the route it replaced.
      // Flattening every refusal to a bare 500 here would model the old
      // behaviour and hide the client's handling of the conflict codes -- the
      // exact seam the original defect lived in.
      if (error && SQL_COMMIT_CONFLICT_CODES.has(error.code)) {
        const body: Record<string, unknown> = { error: error.message, code: error.code };
        if ("currentRevision" in error) body.currentRevision = error.currentRevision;
        if ("expectedChunk" in error) body.expectedChunk = error.expectedChunk;
        if ("migration" in error) body.migration = error.migration;
        rejections.push(String(error?.message));
        return Response.json(body, { status: 409 });
      }
      rejections.push(String(error?.message));
      return Response.json(
        { error: String(error?.message), code: error?.code },
        { status: Number(error?.status) || 500 },
      );
    }
  };

  return {
    server,
    commits,
    rejections,
    newClient: () => new NodeSqliteStorage(request),
    failCommit(ordinal, message) {
      failOrdinal = ordinal;
      failMessage = message;
    },
  };
}

/** A legacy in-memory database of the shape `database.bin` decodes to. */
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

const CHARACTERS = 5;
const CHATS_PER_CHARACTER = 4;
/** Measured through the real builders: one message costs about five statements. */
const STATEMENTS_PER_MESSAGE = 5;

/**
 * The smallest database whose replace-all crosses the client's chunk size
 * `chunks` times over. Sized from the constant, so it re-sizes itself if the
 * chunk size moves rather than quietly stopping at one request.
 */
function databaseSpanningChunks(chunks: number): Database {
  const messagesPerChat = Math.ceil(
    (SQL_MIGRATION_CHUNK_STATEMENTS * chunks) /
    (CHARACTERS * CHATS_PER_CHARACTER * STATEMENTS_PER_MESSAGE),
  );
  return buildLegacyDatabase(CHARACTERS, CHATS_PER_CHARACTER, messagesPerChat);
}

function messageCount(database: Database): number {
  let total = 0;
  for (const character of database.characters) {
    for (const chat of character.chats ?? []) total += chat.message?.length ?? 0;
  }
  return total;
}

function inspect<T>(server: ServerStorage, read: (database: DatabaseSync) => T): T {
  server.checkpoint();
  const inspector = new DatabaseSync(server.databasePath);
  try {
    return read(inspector);
  } finally {
    inspector.close();
  }
}

function rowCount(inspector: DatabaseSync, table: string): number {
  return Number((inspector.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total);
}

describe("chunked legacy-to-SQL migration", () => {
  it("splits a migration too large for one request, and every request stays within the chunk size", async () => {
    const harness = createHarness("risu-chunk-split-");
    const source = databaseSpanningChunks(2.2);

    expect(await harness.newClient().replaceDatabase(source)).toBe(true);
    expect(harness.rejections).toEqual([]);

    // More than one request, none of them oversized.
    expect(harness.commits.length).toBeGreaterThan(1);
    for (const commit of harness.commits) {
      expect(commit.statements.length).toBeGreaterThan(0);
      expect(commit.statements.length).toBeLessThanOrEqual(SQL_MIGRATION_CHUNK_STATEMENTS);
    }

    // Each request is accepted against the revision the previous one returned:
    // `commit()` bumps the revision on every success, so a chunk sent against a
    // stale base would 409 rather than land.
    harness.commits.forEach((commit, index) => {
      expect(commit.baseRevision).toBe(index);
    });

    // The migration is only real if it is in the file on disk AND marked
    // finished. A partially applied migration recorded as a finished one is the
    // failure this whole change exists to make impossible.
    const state = inspect(harness.server, (inspector) => ({
      meta: inspector
        .prepare("SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1")
        .get() as { initialized: number; revision: number },
      characters: rowCount(inspector, "characters"),
      chats: rowCount(inspector, "chats"),
      messages: rowCount(inspector, "messages"),
      marker: inspector
        .prepare("SELECT COUNT(*) AS total FROM system_settings WHERE key = ?")
        .get(SQL_MIGRATION_MARKER_KEY) as { total: number },
    }));
    expect(Number(state.meta.initialized)).toBe(1);
    expect(Number(state.meta.revision)).toBe(harness.commits.length);
    expect(state.characters).toBe(CHARACTERS);
    expect(state.chats).toBe(CHARACTERS * CHATS_PER_CHARACTER);
    expect(state.messages).toBe(messageCount(source));
    // The in-progress marker is cleared by the last chunk, in that chunk's own
    // transaction.
    expect(Number(state.marker.total)).toBe(0);
  }, 300_000);

  it("keeps ordinary commits on the single-request path, however large they are", async () => {
    const harness = createHarness("risu-chunk-single-");
    const client = harness.newClient();

    // A small migration: one request, exactly as before this change.
    const small = buildLegacyDatabase(2, 2, 5);
    expect(await client.replaceDatabase(small)).toBe(true);
    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0].statements.length).toBeLessThanOrEqual(
      SQL_MIGRATION_CHUNK_STATEMENTS,
    );

    // A deliberately huge ORDINARY commit still goes in one request. Chunking a
    // normal save would trade its all-or-nothing transaction for nothing: only
    // a replace-all migration is too big to fit, and only a migration has the
    // in-progress marker that makes a partial write recoverable.
    const bulky = databaseSpanningChunks(1.5);
    const replace = buildSqlReplaceCommit(bulky, 0);
    const sync = createEmptySqlCommit(client.getRevision(), "sync");
    sync.characters = replace.characters;
    sync.chats = replace.chats;
    sync.messages = replace.messages;
    expect(sync.messages.length * STATEMENTS_PER_MESSAGE).toBeGreaterThan(
      SQL_MIGRATION_CHUNK_STATEMENTS,
    );

    await client.commit(sync);
    expect(harness.rejections).toEqual([]);
    expect(harness.commits).toHaveLength(2);
    expect(harness.commits[1].statements.length).toBeGreaterThan(
      SQL_MIGRATION_CHUNK_STATEMENTS,
    );
  }, 300_000);

  it("reports progress that advances while the migration runs", async () => {
    const harness = createHarness("risu-chunk-progress-");
    const events: SqlMigrationProgress[] = [];
    onSqlMigrationProgress((progress) => events.push({ ...progress }));

    await harness.newClient().replaceDatabase(databaseSpanningChunks(2.2));

    // The flattening pass runs before any request and is the phase that looks
    // stuck the longest, so it has to be announced.
    expect(events[0].phase).toBe("preparing");

    const uploads = events.filter((event) => event.phase === "uploading");
    expect(uploads.length).toBeGreaterThan(1);
    // One announcement per request, numbered, against a known total.
    expect(uploads.map((event) => event.chunk)).toEqual(
      harness.commits.map((_, index) => index + 1),
    );
    for (const upload of uploads) {
      expect(upload.chunkCount).toBe(harness.commits.length);
      expect(upload.statementTotal).toBeGreaterThan(SQL_MIGRATION_CHUNK_STATEMENTS);
    }

    // "Still working" has to be distinguishable from "stuck": the text a user
    // sees must actually change between requests.
    const labels = uploads.map(describeSqlMigrationProgress);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toContain("part 1 of ");
    // Work done only ever grows.
    const sent = uploads.map((event) => event.statementsSent);
    expect([...sent].sort((left, right) => left - right)).toEqual(sent);
  }, 300_000);

  it("does not let a half-applied migration pass for a finished one on the next launch", async () => {
    const harness = createHarness("risu-chunk-partial-");
    const source = databaseSpanningChunks(2.2);
    harness.failCommit(2, "connection reset by peer");

    await expect(harness.newClient().replaceDatabase(source)).rejects.toThrow(
      /connection reset by peer/,
    );

    // The file now holds a partial migration, and it says so: the mark raised
    // by the first chunk is still there because the last chunk -- the only
    // thing that clears it -- never ran.
    //
    // `system_storage_meta.initialized` is deliberately NOT asserted here. A
    // server that applies each chunk as an ordinary commit has already set it
    // to 1; one that understands the migration descriptor withholds it. The
    // client has to refuse this database under either, so what is asserted is
    // the client's verdict.
    const partial = inspect(harness.server, (inspector) => ({
      messages: rowCount(inspector, "messages"),
      marker: Number(
        (inspector
          .prepare("SELECT COUNT(*) AS total FROM system_settings WHERE key = ?")
          .get(SQL_MIGRATION_MARKER_KEY) as any).total,
      ),
    }));
    expect(partial.messages).toBeLessThan(messageCount(source));
    expect(partial.marker).toBe(1);

    // ...and a fresh client -- the next launch -- must not read that as a
    // canonical SQL database. "Not complete" is not "ready".
    const nextLaunch = harness.newClient();
    const loaded = await nextLaunch.loadDatabase({ shallow: false });
    expect(loaded?.status).toBe("empty");
    expect(loaded?.database).toBeNull();

    // The recovery path must reach the same verdict, or a degraded startup
    // would adopt the half-migrated database the normal path just refused.
    const recovery = await nextLaunch.loadRecoverySnapshot();
    expect(recovery?.status).toBe("empty");
    expect(recovery?.database).toBeNull();

    // Migrating again over the wreckage succeeds and is then readable.
    expect(await nextLaunch.replaceDatabase(source)).toBe(true);
    const reopened = await harness.newClient().loadDatabase({ shallow: false });
    expect(reopened?.status).toBe("ready");
    expect(reopened?.database?.username).toBe("Migrating User");
    expect(
      inspect(harness.server, (inspector) => rowCount(inspector, "messages")),
    ).toBe(messageCount(source));
  }, 300_000);

  it("refuses a database the server calls ready while it is still flagged mid-migration", async () => {
    // The previous test leans on whatever the server does with a half-applied
    // migration. This one removes the server from the question entirely: the
    // database is initialized, complete as far as the server is concerned, and
    // carries the in-progress mark. A server that applies migration chunks as
    // ordinary commits produces exactly this state, and it is the state the
    // client must never adopt.
    const harness = createHarness("risu-chunk-marked-");
    const client = harness.newClient();
    await client.replaceDatabase(buildLegacyDatabase(2, 2, 5));

    const marked = createEmptySqlCommit(client.getRevision(), "sync");
    marked.root.upserts.push({
      key: SQL_MIGRATION_MARKER_KEY,
      value: "a migration that never finished",
    });
    await client.commit(marked);

    const disk = inspect(harness.server, (inspector) => ({
      initialized: Number(
        (inspector
          .prepare("SELECT initialized FROM system_storage_meta WHERE singleton = 1")
          .get() as any).initialized,
      ),
      characters: rowCount(inspector, "characters"),
    }));
    expect(disk.initialized).toBe(1);
    expect(disk.characters).toBe(2);

    const nextLaunch = harness.newClient();
    const loaded = await nextLaunch.loadDatabase({ shallow: false });
    expect(loaded?.status).toBe("empty");
    expect(loaded?.database).toBeNull();
    const recovery = await nextLaunch.loadRecoverySnapshot();
    expect(recovery?.status).toBe("empty");
    expect(recovery?.database).toBeNull();

    // ...and it is not stuck: migrating again clears the mark and the database
    // becomes readable.
    expect(await nextLaunch.replaceDatabase(buildLegacyDatabase(2, 2, 5))).toBe(true);
    expect((await harness.newClient().loadDatabase({ shallow: false }))?.status).toBe("ready");
  }, 300_000);

  it("says the migration failed, why, and that the app is on the legacy database", async () => {
    const harness = createHarness("risu-chunk-failure-");
    // What the server actually refuses today, delivered the way server.cjs
    // delivers it: status 500 with the message in the body.
    harness.failCommit(1, "SQL commit is too large");

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const legacy = buildLegacyDatabase(2, 2, 5);
    const result = await selectCanonicalDatabase(harness.newClient(), legacy);

    // The fallback is correct and stays: the legacy database is still usable.
    expect(result.usingSql).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.database).toBe(legacy);
    expect(result.error).toBeTruthy();

    // What was missing is the telling. The message has to name the cause the
    // server gave -- which `sendStatements` used to throw away, leaving only
    // "SQL commit failed (500)" -- and name the mode the app is now in.
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("SQL commit is too large");
    expect(failures[0].message).toContain("legacy mode");
    expect(failures[0].error).toBe(result.error);
  }, 300_000);
});

describe("recovering from an abandoned migration", () => {
  /**
   * A migration that dies midway leaves a session row on the server. Only a
   * chunk 0 may supersede it; anything else is refused with
   * SQL_MIGRATION_IN_PROGRESS. So if the client omitted its chunk descriptor
   * whenever a retry happened to fit in a single request, that retry would be
   * refused forever and the user could never leave legacy mode -- a permanent
   * deadlock reachable by the ordinary act of deleting some characters before
   * trying again.
   */
  it("lets a single-request retry supersede a session left by a failed chunked migration", async () => {
    const harness = createHarness("abandoned-migration");
    const big = databaseSpanningChunks(3);

    harness.failCommit(2, "network died mid-migration");
    await expect(harness.newClient().replaceDatabase(big)).rejects.toThrow();

    const abandoned = harness.server.bootstrap().migration;
    expect(abandoned).not.toBeNull();
    expect(Number(abandoned.chunksApplied)).toBeGreaterThan(0);

    // The user trims their data and retries; the replace-all now fits in one
    // request. Before the fix this raised SQL_MIGRATION_IN_PROGRESS.
    const retry = harness.newClient();
    // What selectCanonicalDatabase does: read first, which is also how the
    // client learns the revision the abandoned attempt left behind.
    expect((await retry.loadDatabase())?.status).toBe("empty");
    const small = buildLegacyDatabase(1, 1, 3);
    await expect(retry.replaceDatabase(small)).resolves.toBe(true);

    expect(harness.server.bootstrap().migration).toBeNull();
    const reopened = await harness.newClient().loadDatabase();
    expect(reopened?.status).toBe("ready");
    expect(reopened?.database?.characters).toHaveLength(1);
  });

  it("refuses to close a migration early by shrinking its declared length", () => {
    const harness = createHarness("shrinking-migration");
    const statements = [{ sql: "DELETE FROM characters", bind: [] }];

    harness.server.commit({
      baseRevision: harness.server.revision(),
      action: "replace-all-chunk-1-of-18",
      statements,
      migration: { id: "m", chunk: 0, totalChunks: 18, final: false },
    });

    // Claiming to be the last of two would mark a sixteen-chunk-short database
    // initialized. The length of a migration is fixed when it opens.
    expect(() => harness.server.commit({
      baseRevision: harness.server.revision(),
      action: "replace-all",
      statements,
      migration: { id: "m", chunk: 1, totalChunks: 2, final: true },
    })).toThrow(/chunk total changed mid-sequence/);

    expect(harness.server.bootstrap().migration).not.toBeNull();
  });
});
