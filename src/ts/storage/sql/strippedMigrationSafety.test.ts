import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NodeSqliteStorage,
  SQL_CHAT_HISTORY_AUDIT_KEY,
  SQL_MIGRATION_MARKER_KEY,
} from "./nodeSqliteStorage";
import { selectCanonicalDatabase } from "./sqlBootstrap";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import {
  describeSqlMigrationProgress,
  onSqlMigrationFailure,
  onSqlMigrationProgress,
  resetSqlMigrationListeners,
  type SqlMigrationFailure,
  type SqlMigrationProgress,
} from "./migrationReporting";
import { createEmptySqlCommit } from "./sqlCommit";
import type { Database } from "../database.svelte";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");
const { createChatContentPage } = require("../../../../server/node/chat-content-page.cjs");
const {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  normalizeJSON,
} = require("../../../../server/node/utils.cjs");

/**
 * What the migration of a server-stripped database must do when the chat
 * histories it depends on are not simply all there.
 *
 * `strippedLegacyMigration.test.ts` establishes the happy path: the histories
 * the client never downloaded end up in SQL. This file is about the three ways
 * that can go wrong and one way it already did.
 *
 *   - A chat whose history cannot be READ is not a chat with no history. It
 *     must never be written as an empty one, and the migration that hit it must
 *     not be recorded as finished.
 *   - A chat the server holds NO CONTENT for genuinely has no messages, and
 *     must migrate as an empty chat rather than blocking everything else.
 *   - A migration that lands fewer messages than its source described is
 *     incomplete, whatever the server's `initialized` flag says.
 *   - A database migrated by the release that dropped every history has to get
 *     its messages back on upgrade, without the user knowing anything happened.
 *
 * As in the sibling files, only the HTTP hop is stubbed: the real client talks
 * to a real `relational-sqlite.cjs` database in a temp directory, and the
 * migration input is produced by putting a full legacy database through the
 * server's own strip-encode-decode path.
 */

type ServerStorage = {
  databasePath: string;
  revision(): number;
  bootstrap(options?: unknown): unknown;
  dump(): unknown;
  commit(payload: unknown): { revision: number };
  loadChatMessages(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): { messages: { data?: string }[]; total: number } | null;
  checkpoint(): unknown;
  close(): void;
};

const roots: string[] = [];
const openStorages: ServerStorage[] = [];
afterEach(() => {
  resetDeferredRootKeys();
  resetSqlMigrationListeners();
  for (const storage of openStorages.splice(0)) storage.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface LegacyMessage { chatId: string; role: string; data: string }
interface LegacyChat {
  id: string;
  name: string;
  note: string;
  lastDate: number;
  message: LegacyMessage[];
}
interface LegacyCharacter {
  chaId: string;
  name: string;
  firstMessage: string;
  chats: LegacyChat[];
}
interface LegacyDatabase {
  username: string;
  pluginCustomStorage: Record<string, unknown>;
  botPresets: { id: string; name: string }[];
  botPresetsId: number;
  characters: LegacyCharacter[];
}

const asDatabase = (database: unknown): Database => database as Database;

function buildFullLegacyDatabase(
  characters: number,
  chatsPerCharacter: number,
  messagesPerChat: number,
  messageBody = "line",
): LegacyDatabase {
  return {
    username: "Migrating User",
    pluginCustomStorage: {},
    botPresets: [{ id: "preset-1", name: "Default" }],
    botPresetsId: 0,
    characters: Array.from({ length: characters }, (_, characterIndex) => ({
      chaId: `character-${characterIndex}`,
      name: `Character ${characterIndex}`,
      firstMessage: `Greeting from character ${characterIndex}`,
      chats: Array.from({ length: chatsPerCharacter }, (_, chatIndex) => ({
        id: `character-${characterIndex}-chat-${chatIndex}`,
        name: `Chat ${chatIndex}`,
        // Exists only in the per-chat content: the stub does not carry it, so
        // a migration that wrote chat rows from the stub would lose it.
        note: `note for ${characterIndex}/${chatIndex}`,
        lastDate: 1_700_000_000_000 + chatIndex,
        message: Array.from({ length: messagesPerChat }, (_, messageIndex) => ({
          chatId: `character-${characterIndex}-chat-${chatIndex}-message-${messageIndex}`,
          role: messageIndex % 2 === 0 ? "user" : "char",
          data: `${messageBody} ${characterIndex}/${chatIndex}/${messageIndex}`,
        })),
      })),
    })),
  };
}

/** `server.cjs` `chatToStub` and `stripChatsFromDb`, as `GET /api/read` runs them. */
function stripChatsFromDb(database: LegacyDatabase): unknown {
  return {
    ...database,
    characters: database.characters.map((character) => ({
      ...character,
      chats: character.chats.map((chat) => ({
        id: chat.id,
        name: chat.name,
        _stub: true,
        lastDate: chat.lastDate,
      })),
    })),
  };
}

interface ChatContentPolicy {
  /** Status to answer with instead of serving the chat, keyed by chat id. */
  fail?: Map<string, number>;
  /** Chat ids the server holds no content for at all. */
  missing?: Set<string>;
}

interface Harness {
  server: ServerStorage;
  strippedDatabase: unknown;
  /** Every request the client made, in order. */
  requests: string[];
  chatContentRequests: string[];
  rejections: string[];
  /** Message ids dropped from commits, simulating rows that never landed. */
  swallowMessages: Set<string>;
  policy: ChatContentPolicy;
  newClient(): NodeSqliteStorage;
}

async function createHarness(prefix: string, full: LegacyDatabase): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const server = createRelationalSqlite({ dataRoot: root }) as ServerStorage;
  openStorages.push(server);

  const requests: string[] = [];
  const chatContentRequests: string[] = [];
  const rejections: string[] = [];
  const swallowMessages = new Set<string>();
  const policy: ChatContentPolicy = {};

  const chatsById = new Map<string, LegacyChat>();
  for (const character of full.characters) {
    for (const chat of character.chats) chatsById.set(chat.id, chat);
  }

  const strippedBody: Uint8Array = encodeRisuSaveLegacy(normalizeJSON(stripChatsFromDb(full)));
  const strippedDatabase = normalizeJSON(await decodeRisuSave(strippedBody));

  const chatContentRoute = /^\/api\/chat-content\/([^/?]+)\/(\d+)(\/page)?(\?.*)?$/;

  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(path);

    const chatContent = chatContentRoute.exec(path);
    if (chatContent) {
      chatContentRequests.push(path);
      const paged = Boolean(chatContent[3]);
      const chatId = new Headers(init?.headers).get("x-chat-id") ?? "";
      const failure = policy.fail?.get(chatId);
      if (failure) return Response.json({ error: "upstream said no" }, { status: failure });
      const chat = chatsById.get(chatId);
      if (!chat || policy.missing?.has(chatId)) {
        return Response.json({ error: "Chat not found" }, { status: 404 });
      }
      const query = new URL(path, "https://risu.invalid").searchParams;
      const body: Uint8Array = paged
        ? encodeRisuSaveLegacy(
          createChatContentPage(chat, query.get("offset"), query.get("limit")),
        )
        : encodeRisuSaveLegacy(chat);
      return new Response(body.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }

    if (path.startsWith("/api/sql/bootstrap")) {
      const defer = new URL(path, "https://risu.invalid").searchParams.get("defer");
      return Response.json(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
    }
    if (path === "/api/sql/snapshot") return Response.json(server.dump());

    const messagePage = /^\/api\/sql\/chats\/([^/?]+)\/messages\?(.*)$/.exec(path);
    if (messagePage) {
      const chatId = decodeURIComponent(messagePage[1]);
      const query = new URLSearchParams(messagePage[2]);
      const before = query.get("before");
      const page = server.loadChatMessages(
        chatId,
        before === null ? undefined : Number(before),
        Number(query.get("limit")),
      );
      if (!page) return Response.json({ error: "Chat not found" }, { status: 404 });
      return Response.json(page);
    }

    if (path !== "/api/sql/commit") throw new Error(`unexpected request: ${path}`);
    const payload = JSON.parse(String(init?.body)) as {
      statements: { sql: string; bind: unknown[] }[];
    };
    if (swallowMessages.size > 0) {
      // A server that accepts a commit and stores less than it was sent. The
      // client cannot see this happen; it can only compare afterwards. Every
      // statement about the message goes, rows and relational nodes alike, so
      // what is left is a consistent database that is simply short.
      payload.statements = payload.statements.filter((statement) =>
        !(/messages|message_extension_nodes/.test(String(statement.sql)) &&
          (statement.bind ?? []).some((value) => swallowMessages.has(String(value)))));
    }
    try {
      return Response.json(server.commit(payload));
    } catch (error: any) {
      if (error?.code === "SQL_REVISION_CONFLICT") {
        return Response.json({ currentRevision: error.currentRevision }, { status: 409 });
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
    strippedDatabase,
    requests,
    chatContentRequests,
    rejections,
    swallowMessages,
    policy,
    newClient: () => new NodeSqliteStorage(request),
  };
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

function messageCount(inspector: DatabaseSync, chatId?: string): number {
  const row = chatId === undefined
    ? inspector.prepare("SELECT COUNT(*) AS total FROM messages").get()
    : inspector.prepare("SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?").get(chatId);
  return Number((row as any).total);
}

function settingCount(inspector: DatabaseSync, key: string): number {
  return Number((inspector
    .prepare("SELECT COUNT(*) AS total FROM system_settings WHERE key = ?")
    .get(key) as any).total);
}

describe("a chat history that could not be read", () => {
  it("is never written as an empty chat, and the migration is not recorded as finished", async () => {
    const full = buildFullLegacyDatabase(2, 2, 12);
    const harness = await createHarness("risu-fetch-failure-", full);
    // One chat's history is unreachable. Everything else is fine, which is what
    // makes this dangerous: the migration would otherwise "succeed".
    harness.policy.fail = new Map([["character-1-chat-0", 503]]);

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const legacy = asDatabase(harness.strippedDatabase);
    const result = await selectCanonicalDatabase(harness.newClient(), legacy);

    // The legacy source stays canonical, and the user is told why.
    expect(result.usingSql).toBe(false);
    expect(result.migrated).toBe(false);
    expect(result.database).toBe(legacy);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("character-1-chat-0");
    expect(failures[0].message).toContain("legacy mode");

    // It really did try more than once before giving up: a single dropped
    // request must not cost a user their migration.
    const attempts = harness.chatContentRequests.filter((path) =>
      path.includes("/character-1/0")).length;
    expect(attempts).toBeGreaterThan(1);

    // On a database this size the whole migration is still in the first,
    // unsent chunk when the fetch gives up, so nothing was written at all --
    // not even the chat rows. The strongest form of "not written empty".
    expect(harness.requests.filter((path) => path === "/api/sql/commit")).toEqual([]);
    const state = inspect(harness.server, (inspector) => ({
      revision: Number((inspector
        .prepare("SELECT revision FROM system_storage_meta WHERE singleton = 1")
        .get() as any).revision),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
      chats: Number((inspector.prepare("SELECT COUNT(*) AS total FROM chats").get() as any).total),
      messages: messageCount(inspector),
    }));
    expect(state.revision).toBe(0);
    expect(state.chats).toBe(0);
    expect(state.messages).toBe(0);
    expect(state.audit).toBe(0);

    // The decisive check: what the next launch reads. A chat written empty and
    // marked complete is what this whole file exists to prevent.
    const nextLaunch = await harness.newClient().loadDatabase({ shallow: false });
    expect(nextLaunch?.status).toBe("empty");
    expect(nextLaunch?.database).toBeNull();
  }, 120_000);

  it("leaves the half-written database flagged when it fails after chunks are already sent", async () => {
    // Big enough that the migration has committed several chunks before it
    // reaches the unreadable chat, so there IS a partially written database.
    // The in-progress marker raised in the first chunk is what keeps it from
    // being read as a finished one, and it is never cleared.
    const full = buildFullLegacyDatabase(3, 2, 800);
    const harness = await createHarness("risu-fetch-failure-late-", full);
    harness.policy.fail = new Map([["character-2-chat-1", 500]]);

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const legacy = asDatabase(harness.strippedDatabase);
    const result = await selectCanonicalDatabase(harness.newClient(), legacy);

    expect(result.usingSql).toBe(false);
    expect(result.database).toBe(legacy);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("character-2-chat-1");

    const state = inspect(harness.server, (inspector) => ({
      marker: settingCount(inspector, SQL_MIGRATION_MARKER_KEY),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
      initialized: Number((inspector
        .prepare("SELECT initialized FROM system_storage_meta WHERE singleton = 1")
        .get() as any).initialized),
      messages: messageCount(inspector),
      unreadableChat: messageCount(inspector, "character-2-chat-1"),
    }));
    // Chunks landed, so the database really does hold part of the data...
    expect(state.messages).toBeGreaterThan(0);
    expect(state.unreadableChat).toBe(0);
    // ...and it is marked for exactly that reason.
    expect(state.marker).toBe(1);
    expect(state.audit).toBe(0);

    const nextLaunch = await harness.newClient().loadDatabase({ shallow: false });
    expect(nextLaunch?.status).toBe("empty");
    expect(nextLaunch?.database).toBeNull();
  }, 300_000);

  it("is distinguished from a chat the server holds no content for", async () => {
    const full = buildFullLegacyDatabase(2, 2, 12);
    const harness = await createHarness("risu-fetch-absent-", full);
    // 404 from both routes: this chat has no stored content. A chat created and
    // never used looks exactly like this, and it is a real answer.
    harness.policy.missing = new Set(["character-1-chat-0"]);

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const result = await selectCanonicalDatabase(
      harness.newClient(),
      asDatabase(harness.strippedDatabase),
    );

    expect(failures).toEqual([]);
    expect(result.usingSql).toBe(true);
    expect(result.migrated).toBe(true);

    const state = inspect(harness.server, (inspector) => ({
      total: messageCount(inspector),
      absent: messageCount(inspector, "character-1-chat-0"),
      neighbour: messageCount(inspector, "character-1-chat-1"),
      marker: settingCount(inspector, SQL_MIGRATION_MARKER_KEY),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
      // The stub carries `id`, `name` and `lastDate` and nothing else. A chat
      // row written from the stub would lose the rest of the chat along with
      // its history, so the row has to come from the content copy.
      note: (inspector.prepare("SELECT note FROM chats WHERE id = ?")
        .get("character-0-chat-0") as any).note,
      absentNote: (inspector.prepare("SELECT name FROM chats WHERE id = ?")
        .get("character-1-chat-0") as any).name,
    }));
    expect(state.note).toBe("note for 0/0");
    // ...and the chat the server has no content for still gets its row, from
    // the only description of it that exists.
    expect(state.absentNote).toBe("Chat 0");
    expect(state.absent).toBe(0);
    // The other three chats migrated in full: one empty chat does not cost the
    // rest their histories.
    expect(state.total).toBe(3 * 12);
    expect(state.neighbour).toBe(12);
    expect(state.marker).toBe(0);
    expect(state.audit).toBe(1);
  }, 120_000);
});

describe("a migration that holds less than its source described", () => {
  it("is not marked finished, whatever the server's initialized flag says", async () => {
    const full = buildFullLegacyDatabase(1, 2, 10);
    const harness = await createHarness("risu-shortfall-", full);
    // Four messages of one chat never land. Everything else does, the server
    // reports success on every commit, and `initialized` reaches 1.
    for (let index = 0; index < 4; index++) {
      harness.swallowMessages.add(`character-0-chat-1-message-${index}`);
    }

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const legacy = asDatabase(harness.strippedDatabase);
    const result = await selectCanonicalDatabase(harness.newClient(), legacy);

    expect(result.usingSql).toBe(false);
    expect(result.database).toBe(legacy);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("character-0-chat-1");
    expect(failures[0].message).toContain("6 of 10");

    const state = inspect(harness.server, (inspector) => ({
      marker: settingCount(inspector, SQL_MIGRATION_MARKER_KEY),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
    }));
    expect(state.marker).toBe(1);
    expect(state.audit).toBe(0);

    const nextLaunch = await harness.newClient().loadDatabase({ shallow: false });
    expect(nextLaunch?.status).toBe("empty");
  }, 120_000);

  it("is caught on the path that has no chats to fetch, and the database is flagged after the fact", async () => {
    // A database that carries its own histories migrates in one request and is
    // marked initialized by that request, so there is no marker being withheld.
    // The check still has to bite: it raises the marker afterwards.
    const full = buildFullLegacyDatabase(1, 1, 8);
    const harness = await createHarness("risu-shortfall-resident-", full);
    harness.swallowMessages.add("character-0-chat-0-message-0");

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const result = await selectCanonicalDatabase(harness.newClient(), asDatabase(full));

    expect(result.usingSql).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain("7 of 8");

    const state = inspect(harness.server, (inspector) => ({
      marker: settingCount(inspector, SQL_MIGRATION_MARKER_KEY),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
      messages: messageCount(inspector),
      initialized: Number((inspector
        .prepare("SELECT initialized FROM system_storage_meta WHERE singleton = 1")
        .get() as any).initialized),
    }));
    expect(state.messages).toBe(7);
    expect(state.initialized).toBe(1);
    // ...and the marker put there afterwards is what stops the next launch
    // adopting it anyway.
    expect(state.marker).toBe(1);
    expect(state.audit).toBe(0);

    const nextLaunch = await harness.newClient().loadDatabase({ shallow: false });
    expect(nextLaunch?.status).toBe("empty");
  }, 120_000);
});

describe("what the migration says while it is fetching", () => {
  it("reports the chat it is downloading rather than looking stuck", async () => {
    const full = buildFullLegacyDatabase(2, 3, 20);
    const harness = await createHarness("risu-progress-", full);
    const events: SqlMigrationProgress[] = [];
    onSqlMigrationProgress((progress) => events.push({ ...progress }));

    await selectCanonicalDatabase(harness.newClient(), asDatabase(harness.strippedDatabase));

    const fetching = events.filter((event) => event.phase === "fetching");
    expect(fetching.length).toBeGreaterThan(0);
    // One announcement per chat before its first page, and the counter only
    // ever goes forward.
    expect(fetching.at(-1)?.chat).toBe(6);
    expect(fetching.every((event) => event.chatCount === 6)).toBe(true);
    const chats = fetching.map((event) => event.chat ?? 0);
    expect([...chats].sort((left, right) => left - right)).toEqual(chats);
    // Messages downloaded is the other number that moves, so the label changes
    // even while a single long chat is being pulled.
    expect(fetching.at(-1)?.messagesFetched).toBe(120);

    const label = describeSqlMigrationProgress(fetching.at(-1)!);
    expect(label).toContain("downloading chat 6 of 6");
    expect(new Set(fetching.map(describeSqlMigrationProgress)).size).toBeGreaterThan(1);

    // The upload phase no longer claims a total it cannot know, and says so
    // rather than printing "part 2 of 0".
    const uploads = events.filter((event) => event.phase === "uploading");
    expect(uploads.length).toBeGreaterThan(0);
    expect(describeSqlMigrationProgress(uploads[0])).toBe("Migrating to SQL: sending part 1");
  }, 120_000);
});

describe("the histories are streamed, not collected", () => {
  it("sends chats it has already fetched before it has fetched the rest", async () => {
    // Large enough to cross the client's per-request statement budget, so the
    // migration must send more than one chunk. If the histories were collected
    // first, every chat-content request would precede every commit.
    const full = buildFullLegacyDatabase(3, 2, 800);
    const harness = await createHarness("risu-streaming-", full);

    const result = await selectCanonicalDatabase(
      harness.newClient(),
      asDatabase(harness.strippedDatabase),
    );
    expect(result.migrated).toBe(true);

    const isCommit = (path: string) => path === "/api/sql/commit";
    const isContent = (path: string) => path.startsWith("/api/chat-content/");
    const commits = harness.requests.map((path, index) => isCommit(path) ? index : -1)
      .filter((index) => index >= 0);
    const lastContent = harness.requests.reduce(
      (last, path, index) => isContent(path) ? index : last, -1);

    expect(commits.length).toBeGreaterThan(2);
    expect(lastContent).toBeGreaterThan(-1);
    // At least one full chunk was sent and released while chats were still
    // being downloaded. That is the whole memory argument, observable.
    const commitsBeforeTheLastFetch = commits.filter((index) => index < lastContent);
    expect(commitsBeforeTheLastFetch.length).toBeGreaterThan(0);

    const stored = inspect(harness.server, (inspector) => messageCount(inspector));
    expect(stored).toBe(3 * 2 * 800);
  }, 300_000);
});

describe("a database the broken release already migrated", () => {
  /**
   * Reproduce the damage exactly: the commit that release built from a stripped
   * database. Chats, no messages, empty message manifests, replace-all -- and
   * the server marks it initialized, because it is a complete commit as far as
   * the server can tell.
   */
  async function migrateTheBrokenWay(harness: Harness, full: LegacyDatabase): Promise<void> {
    const client = harness.newClient();
    await client.init();
    const commit = createEmptySqlCommit(client.getRevision(), "replace-all");
    commit.replaceAll = true;
    commit.characterIds = [];
    commit.pluginStorage = { upserts: [], deletes: [], clear: true };
    commit.root.upserts.push({ key: "username", value: full.username });
    full.characters.forEach((character, characterPosition) => {
      commit.characterIds!.push(character.chaId);
      commit.characters.push({
        id: character.chaId,
        position: characterPosition,
        data: { name: character.name, firstMessage: character.firstMessage },
      });
      commit.chatManifests.push({
        characterId: character.chaId,
        ids: character.chats.map((chat) => chat.id),
      });
      character.chats.forEach((chat, chatPosition) => {
        commit.chats.push({
          id: chat.id,
          characterId: character.chaId,
          position: chatPosition,
          data: { name: chat.name, lastDate: chat.lastDate },
        });
        // `chat.message ?? []` on a stub: the defect, verbatim.
        commit.messageManifests.push({ chatId: chat.id, ids: [] });
      });
    });
    await client.commit(commit);
  }

  it("gets its messages back on the next launch, without the user doing anything", async () => {
    const full = buildFullLegacyDatabase(2, 2, 15);
    const harness = await createHarness("risu-repair-", full);
    await migrateTheBrokenWay(harness, full);

    // The state the user is actually in: SQL is canonical and every chat is
    // empty, so every chat opens showing only the character's greeting.
    const damaged = inspect(harness.server, (inspector) => ({
      messages: messageCount(inspector),
      initialized: Number((inspector
        .prepare("SELECT initialized FROM system_storage_meta WHERE singleton = 1")
        .get() as any).initialized),
      marker: settingCount(inspector, SQL_MIGRATION_MARKER_KEY),
    }));
    expect(damaged.messages).toBe(0);
    expect(damaged.initialized).toBe(1);
    expect(damaged.marker).toBe(0);

    const result = await selectCanonicalDatabase(
      harness.newClient(),
      asDatabase(harness.strippedDatabase),
    );

    expect(result.usingSql).toBe(true);
    // A re-migration, deliberately. An in-place repair has to work out which
    // chats are wrong, and a chat written into since the break no longer looks
    // wrong -- so it would be skipped and its history lost for good. Re-running
    // the migration from the legacy source cannot miss one.
    expect(result.migrated).toBe(true);

    const repaired = inspect(harness.server, (inspector) => ({
      messages: messageCount(inspector),
      firstChat: messageCount(inspector, "character-0-chat-0"),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
    }));
    expect(repaired.messages).toBe(2 * 2 * 15);
    expect(repaired.firstChat).toBe(15);
    expect(repaired.audit).toBe(1);

    // The history reads back in order through the client's own paging API,
    // which is what fills the chat view.
    const page = await harness.newClient().loadChatMessagePage("character-0-chat-0", undefined, 100);
    expect(page.total).toBe(15);
    expect(page.messages.map((message: any) => message.data)).toEqual(
      full.characters[0].chats[0].message.map((message) => message.data),
    );

    // The audit is bookkeeping, not user data: it must not turn up in the
    // database object the app hands around and writes back.
    expect(result.database).not.toHaveProperty(SQL_CHAT_HISTORY_AUDIT_KEY);
  }, 120_000);

  it("restores a chat that has been written in since, which an in-place repair would skip", async () => {
    const full = buildFullLegacyDatabase(1, 2, 15);
    const harness = await createHarness("risu-repair-once-", full);
    await migrateTheBrokenWay(harness, full);

    // The user kept using one chat after the broken migration, so it is no
    // longer empty. That is exactly the chat an emptiness-based repair cannot
    // see: it would be skipped, stamped as checked, and its real history would
    // never come back.
    const client = harness.newClient();
    await client.init();
    const written = createEmptySqlCommit(client.getRevision(), "sync");
    written.messages.push({
      id: "written-after-the-break",
      chatId: "character-0-chat-1",
      position: 0,
      data: { role: "user", data: "written after the break" },
    });
    await client.commit(written);

    await selectCanonicalDatabase(harness.newClient(), asDatabase(harness.strippedDatabase));

    const state = inspect(harness.server, (inspector) => ({
      untouched: messageCount(inspector, "character-0-chat-0"),
      writtenIn: messageCount(inspector, "character-0-chat-1"),
      audit: settingCount(inspector, SQL_CHAT_HISTORY_AUDIT_KEY),
    }));
    // Both chats hold the server's history, the written-in one included.
    expect(state.untouched).toBe(15);
    expect(state.writtenIn).toBe(15);
    expect(state.audit).toBe(1);

    // The cost of re-migrating: the message typed on the broken build is not in
    // the legacy source, so it is not carried over. The database it replaced is
    // archived by the server rather than dropped, which is what makes that
    // recoverable instead of lost.
    expect((harness.server.bootstrap() as { migration?: unknown }).migration ?? null).toBeNull();

    // Second launch: the stamp is recorded, so nothing re-migrates and nothing
    // asks the server for chat content again.
    const before = harness.chatContentRequests.length;
    const second = await selectCanonicalDatabase(
      harness.newClient(),
      asDatabase(harness.strippedDatabase),
    );
    expect(second.migrated).toBe(false);
    expect(harness.chatContentRequests.length).toBe(before);
  }, 120_000);
});
