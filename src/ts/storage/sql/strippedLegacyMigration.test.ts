import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteStorage, SQL_MIGRATION_MARKER_KEY } from "./nodeSqliteStorage";
import { selectCanonicalDatabase } from "./sqlBootstrap";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import {
  onSqlMigrationFailure,
  resetSqlMigrationListeners,
  type SqlMigrationFailure,
} from "./migrationReporting";
import { isChatStub } from "../chatStub";
import type { Database } from "../database.svelte";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");
const { createChatContentPage } = require("../../../../server/node/chat-content-page.cjs");
const {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  normalizeJSON,
} = require("../../../../server/node/utils.cjs");

/**
 * Legacy-to-SQL migration of the database the client actually receives.
 *
 * Every migration test in this directory so far has built its legacy database
 * in memory with the messages already inside it. No client has ever held such
 * a database. `GET /api/read` (server.cjs, the `database/database.bin` branch)
 * runs the decoded database through `stripChatsFromDb` before it encodes the
 * response, so every chat reaches the client as a stub -- `{ id, name, _stub:
 * true }` and, decisively, no `message` key at all. The histories stay on the
 * server in `fullChatStore` and are handed out one chat at a time by
 * `GET /api/chat-content/:chaId/:chatIndex/page` (and its unpaged sibling),
 * keyed by an `x-chat-id` header.
 *
 * A 50 MB `database.bin` is therefore 50 MB of characters, lorebooks, modules
 * and presets, and zero messages. `buildSqlReplaceCommit` emits `chat.message
 * ?? []` with no completeness condition, so migrating that object writes an
 * empty history for every chat and then marks the SQL database canonical. The
 * user's chats open blank, showing only the greeting, which lives on the
 * character rather than in `chat.message`.
 *
 * The fixture below is built the only way that can catch this: the full
 * database is stripped, encoded, and decoded again through the server's own
 * `utils.cjs` codec, and the migration input is whatever comes out the far
 * end. Nothing hand-writes the object the migration sees, and the per-chat
 * endpoint -- answered here by the server's real `createChatContentPage` -- is
 * the only place the messages exist, exactly as in production.
 *
 * As everywhere else in this directory, only the HTTP hop is stubbed: the real
 * `NodeSqliteStorage` talks to a real `relational-sqlite.cjs` database in a
 * temp directory.
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

// ── The legacy database as it exists on the server's disk ────────────────────

interface LegacyMessage {
  chatId: string;
  role: string;
  data: string;
}
interface LegacyChat {
  id: string;
  name: string;
  lastDate: number;
  message: LegacyMessage[];
}
interface LegacyCharacter {
  chaId: string;
  name: string;
  firstMessage: string;
  chats: LegacyChat[];
}

/**
 * The legacy shapes are declared standalone rather than as an intersection
 * with `Database`, whose `Chat` is the runtime type with `id` optional and
 * `message` required. A stub is neither, and the migration input is a stub.
 * `Database` is asserted only where production code is handed the object.
 */
interface LegacyDatabase {
  username: string;
  pluginCustomStorage: Record<string, unknown>;
  botPresets: { id: string; name: string }[];
  botPresetsId: number;
  characters: LegacyCharacter[];
}

/** What `GET /api/read` hands back: the same database with stubs for chats. */
type ChatStubShape = { id: string; name: string; _stub: true; lastDate?: number };
interface StrippedCharacter {
  chaId: string;
  name: string;
  firstMessage: string;
  chats: ChatStubShape[];
}
interface StrippedDatabase {
  username: string;
  characters: StrippedCharacter[];
}

/** The single point where a legacy-shaped object is handed to production code. */
const asDatabase = (database: StrippedDatabase | LegacyDatabase): Database =>
  database as unknown as Database;

/**
 * The full `database.bin` as it sits on the server, messages included.
 *
 * `firstMessage` is the greeting. It lives on the character, which is why a
 * chat whose history was dropped still shows one line instead of nothing --
 * the symptom that made this look like a rendering bug rather than data loss.
 */
function buildFullLegacyDatabase(
  characters: number,
  chatsPerCharacter: number,
  messagesPerChat: number,
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
        lastDate: 1_700_000_000_000 + chatIndex,
        message: Array.from({ length: messagesPerChat }, (_, messageIndex) => ({
          chatId: `character-${characterIndex}-chat-${chatIndex}-message-${messageIndex}`,
          role: messageIndex % 2 === 0 ? "user" : "char",
          data: `${MESSAGE_MARKER} ${characterIndex}/${chatIndex}/${messageIndex}`,
        })),
      })),
    })),
  } as unknown as LegacyDatabase;
}

/**
 * Present in every message body and nowhere else, so a search of the encoded
 * response can prove the messages really are absent from what the client
 * downloads rather than merely absent from where we looked.
 */
const MESSAGE_MARKER = "irreplaceable-chat-line";

// ── What GET /api/read does to it in transit ─────────────────────────────────

/**
 * `server.cjs` `chatToStub`: metadata only, and no `message` key. Key presence
 * is preserved for the optional fields because the server merge layer reads
 * them with `in`.
 */
function chatToStub(chat: LegacyChat): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    id: chat.id || "",
    name: chat.name ?? "",
    _stub: true,
  };
  if ("lastDate" in chat) stub.lastDate = chat.lastDate;
  if ("folderId" in chat) stub.folderId = (chat as Record<string, unknown>).folderId;
  if ("modules" in chat) stub.modules = (chat as Record<string, unknown>).modules;
  return stub;
}

/** `server.cjs` `stripChatsFromDb`: a new object, every chat reduced to a stub. */
function stripChatsFromDb(database: LegacyDatabase): unknown {
  return {
    ...database,
    characters: database.characters.map((character) => ({
      ...character,
      chats: character.chats.map(chatToStub),
    })),
  };
}

/** `server.cjs` `initChatStore`: the payloads, keyed chaId -> chatId. */
function initChatStore(
  database: LegacyDatabase,
): Map<string, Map<string, LegacyChat>> {
  const store = new Map<string, Map<string, LegacyChat>>();
  for (const character of database.characters) {
    const chats = new Map<string, LegacyChat>();
    for (const chat of character.chats) chats.set(chat.id, chat);
    store.set(character.chaId, chats);
  }
  return store;
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface ChatContentRequest {
  chaId: string;
  chatIndex: number;
  chatId: string;
  paged: boolean;
}

interface Harness {
  server: ServerStorage;
  /** The migration input: what the client decodes out of `GET /api/read`. */
  strippedDatabase: StrippedDatabase;
  /** The encoded response body, so its contents can be searched. */
  strippedBody: Uint8Array;
  /** Every `/api/chat-content/...` request the client made, in order. */
  chatContentRequests: ChatContentRequest[];
  /** Messages the server refused, which the 500 response body carries. */
  rejections: string[];
  newClient(): NodeSqliteStorage;
  /**
   * The number of messages the per-chat endpoint reports for one chat, read
   * over the same transport the client uses. This is what the source
   * "describes": the stub itself carries no count, so the endpoint's `total`
   * is the only statement anywhere of how long the history is.
   */
  describedMessages(chaId: string, chatIndex: number, chatId: string): Promise<number>;
}

async function createHarness(
  prefix: string,
  full: LegacyDatabase,
): Promise<Harness> {
  const server = createServer(prefix);
  const fullChatStore = initChatStore(full);
  const chatContentRequests: ChatContentRequest[] = [];
  const rejections: string[] = [];

  // The client's migration input, produced the way the server produces it:
  // stripped, normalized, encoded, and decoded again with the server's own
  // codec. Whatever this yields is what the migration gets to work with.
  const strippedBody: Uint8Array = encodeRisuSaveLegacy(normalizeJSON(stripChatsFromDb(full)));
  const strippedDatabase = normalizeJSON(await decodeRisuSave(strippedBody)) as StrippedDatabase;

  const chatContentRoute = /^\/api\/chat-content\/([^/?]+)\/(\d+)(\/page)?(\?.*)?$/;

  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);

    const chatContent = chatContentRoute.exec(path);
    if (chatContent) {
      const chaId = decodeURIComponent(chatContent[1]);
      const chatIndex = Number(chatContent[2]);
      const paged = Boolean(chatContent[3]);
      const headers = new Headers(init?.headers);
      const expectedChatId = headers.get("x-chat-id") ?? "";
      chatContentRequests.push({ chaId, chatIndex, chatId: expectedChatId, paged });

      const chats = fullChatStore.get(chaId);
      const chat = expectedChatId ? chats?.get(expectedChatId) : undefined;
      // Mirrors the route: a miss in the store falls back to the index, and a
      // chat id that does not match the index is a 409, never a silent swap.
      const byIndex = full.characters.find((c) => c.chaId === chaId)?.chats?.[chatIndex];
      const resolved = chat ?? byIndex;
      if (!resolved) return Response.json({ error: "Chat not found" }, { status: 404 });
      if (expectedChatId && resolved.id !== expectedChatId) {
        return Response.json({ error: "Chat ID mismatch" }, { status: 409 });
      }

      const query = new URL(path, "https://risu.invalid").searchParams;
      const body: Uint8Array = paged
        ? encodeRisuSaveLegacy(
            createChatContentPage(resolved, query.get("offset"), query.get("limit")),
          )
        : encodeRisuSaveLegacy(resolved);
      // `.slice()` yields an exactly-sized copy, so the ArrayBuffer handed to
      // Response carries the encoded bytes and nothing else.
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
    try {
      return Response.json(server.commit(JSON.parse(String(init?.body))));
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
    strippedBody,
    chatContentRequests,
    rejections,
    newClient: () => new NodeSqliteStorage(request),
    async describedMessages(chaId, chatIndex, chatId) {
      const response = await request(
        `/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}/page?offset=0&limit=10`,
        { headers: { "x-chat-id": chatId } },
      );
      const page = (await decodeRisuSave(new Uint8Array(await response.arrayBuffer()))) as {
        total: number;
      };
      return page.total;
    },
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

function rowCount(inspector: DatabaseSync, table: string): number {
  return Number((inspector.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total);
}

const CHARACTERS = 3;
const CHATS_PER_CHARACTER = 2;
const MESSAGES_PER_CHAT = 40;

describe("legacy-to-SQL migration of a server-stripped database", () => {
  it("keeps the chat histories the client never downloaded", async () => {
    const full = buildFullLegacyDatabase(CHARACTERS, CHATS_PER_CHARACTER, MESSAGES_PER_CHAT);
    const harness = await createHarness("risu-stripped-migration-", full);
    const totalMessages = CHARACTERS * CHATS_PER_CHARACTER * MESSAGES_PER_CHAT;

    // The fixture must really be stripped, or this test passes for the wrong
    // reason -- the same way every earlier migration test passed.
    const stubs = harness.strippedDatabase.characters.flatMap((character) => character.chats);
    expect(stubs).toHaveLength(CHARACTERS * CHATS_PER_CHARACTER);
    for (const stub of stubs) {
      expect(isChatStub(stub)).toBe(true);
      expect("message" in stub).toBe(false);
    }
    // ...and the download genuinely does not contain the histories: not merely
    // absent from `chat.message`, absent from the bytes.
    expect(Buffer.from(harness.strippedBody).includes(MESSAGE_MARKER)).toBe(false);
    // The greeting does survive, because it lives on the character. That is
    // the whole reason a chat with a dropped history still renders one line.
    expect(harness.strippedBody.length).toBeGreaterThan(0);
    expect(harness.strippedDatabase.characters[0].firstMessage).toBe(
      "Greeting from character 0",
    );

    // The per-chat endpoint is the only remaining copy, and it has them all.
    for (const character of full.characters) {
      for (const [chatIndex, chat] of character.chats.entries()) {
        await expect(
          harness.describedMessages(character.chaId, chatIndex, chat.id),
        ).resolves.toBe(MESSAGES_PER_CHAT);
      }
    }
    const describedBeforeMigrating = harness.chatContentRequests.length;

    const failures: SqlMigrationFailure[] = [];
    onSqlMigrationFailure((failure) => failures.push(failure));

    const result = await selectCanonicalDatabase(harness.newClient(), asDatabase(harness.strippedDatabase));

    expect(
      failures.map((failure) => failure.message),
      "the migration of a stripped database reported a failure",
    ).toEqual([]);
    expect(harness.rejections).toEqual([]);
    expect(result.usingSql).toBe(true);
    expect(result.migrated).toBe(true);

    const fetchedDuringMigration =
      harness.chatContentRequests.length - describedBeforeMigrating;
    const diagnostic =
      `SQL is now canonical. The migration made ${fetchedDuringMigration} request(s) to ` +
      "/api/chat-content, the only place the chat histories exist.";

    // What the user opens the app to see. Counted on disk first, so a shortfall
    // is attributed to the migration rather than to the read path.
    const stored = inspect(harness.server, (inspector) => ({
      characters: rowCount(inspector, "characters"),
      chats: rowCount(inspector, "chats"),
      messages: rowCount(inspector, "messages"),
    }));
    expect(stored.characters).toBe(CHARACTERS);
    expect(stored.chats).toBe(CHARACTERS * CHATS_PER_CHARACTER);
    expect(stored.messages, diagnostic).toBe(totalMessages);

    // ...and every chat reads back with its own history, in order, through the
    // client's own paging API -- which is how the chat view fills itself.
    const client = harness.newClient();
    for (const character of full.characters) {
      for (const chat of character.chats) {
        const page = await client.loadChatMessagePage(chat.id, undefined, 100);
        expect(page.total, `${chat.id}: ${diagnostic}`).toBe(MESSAGES_PER_CHAT);
        expect(page.messages.map((message: any) => message.data)).toEqual(
          chat.message.map((message) => message.data),
        );
      }
    }
  }, 300_000);

  it("does not record a migration as finished while it holds fewer messages than the source described", async () => {
    // The safety net that does not exist. Nothing in the migration path ever
    // compares what it wrote against what the source said was there, so an
    // empty history was written, verified by reloading the same emptiness, and
    // marked canonical -- and the user's only remaining copy of those messages
    // is now behind a database SQL has been declared the owner of.
    const full = buildFullLegacyDatabase(1, 1, MESSAGES_PER_CHAT);
    const harness = await createHarness("risu-stripped-shortfall-", full);
    const character = full.characters[0];
    const chat = character.chats[0];

    const described = await harness.describedMessages(character.chaId, 0, chat.id);
    expect(described).toBe(MESSAGES_PER_CHAT);

    const result = await selectCanonicalDatabase(harness.newClient(), asDatabase(harness.strippedDatabase));

    const stored = inspect(harness.server, (inspector) => ({
      messages: rowCount(inspector, "messages"),
      initialized: Number(
        (
          inspector
            .prepare("SELECT initialized FROM system_storage_meta WHERE singleton = 1")
            .get() as any
        ).initialized,
      ),
      marker: Number(
        (
          inspector
            .prepare("SELECT COUNT(*) AS total FROM system_settings WHERE key = ?")
            .get(SQL_MIGRATION_MARKER_KEY) as any
        ).total,
      ),
    }));

    // "Marked complete" measured every way the product measures it: the
    // bootstrap's own verdict, the server's initialized flag with no
    // in-progress mark left standing, and -- decisively -- what the next
    // launch reads, since that is what makes SQL canonical over the legacy
    // file the user could otherwise still open.
    const nextLaunch = await harness.newClient().loadDatabase({ shallow: false });
    const recordedAsFinished =
      result.migrated &&
      result.usingSql &&
      stored.initialized === 1 &&
      stored.marker === 0 &&
      nextLaunch?.status === "ready";

    expect(
      recordedAsFinished && stored.messages < described,
      `A migration holding ${stored.messages} of the ${described} messages the source described ` +
        "was recorded as finished: initialized=" + stored.initialized +
        ", in-progress mark=" + stored.marker +
        ", next launch status=" + String(nextLaunch?.status) +
        ", migrated=" + String(result.migrated) + ".",
    ).toBe(false);
  }, 300_000);
});
