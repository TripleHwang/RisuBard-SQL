// @vitest-environment node
/**
 * The user's change must reach SQLite.
 *
 * Node environment for the same reason as `sqlReversePageLive.svelte.test.ts`:
 * happy-dom's `fetch` enforces the same-origin policy and cannot reach
 * `http://127.0.0.1:<port>`. Nothing below the HTTP boundary is stubbed -- the
 * rows are read back out of SQLite through the same storage object the app
 * builds at boot.
 *
 * What makes this test different from every other live test here is the
 * ORDERING. The others build one `$state` database and hand that very object to
 * `activateSqlPersistenceRuntime`, so the object persistence holds and the
 * object the test mutates are the same proxy and the raw/proxy split never
 * appears. Boot does the opposite: `openExistingStandaloneSql` activates
 * persistence with the plain object storage returned, and only afterwards is
 * that same object wrapped as `DBState.db`. A Svelte 5 `$state` proxy never
 * writes through to its target, so from that moment the two diverge for good.
 *
 * Two things are stood in for, and only two.
 *
 * `database.svelte` cannot be imported in a node environment (`stores.svelte`
 * calls `window.addEventListener` at module scope), so the one line it
 * contributes -- `publishLiveDatabase(() => DBState.db)` -- is written out here
 * against a local holder that plays the part of `DBState`.
 *
 * And the proxy is created by calling Svelte's `proxy()` directly rather than by
 * writing through a `$state` rune. In a node environment vite-plugin-svelte
 * applies the SERVER transform, where `$state` compiles to a plain assignment
 * and no proxy is created at all -- writing `holder.db = stored` there leaves
 * `holder.db === stored`, which is precisely the condition under which this bug
 * is invisible. (That is not a detail of this test: every existing live test in
 * this directory declares its database with `$state` under
 * `@vitest-environment node`, so none of them has ever held a proxy, and none of
 * them could have caught this.) `proxy()` is the exact call the client build of
 * `$state` makes on assignment -- `proxy.js`'s `set` trap runs
 * `set(s, proxy(value))` -- so this holder behaves as `DBState.db` behaves in a
 * browser.
 *
 * Everything else is the production path: the real `openExistingStandaloneSql`,
 * the real persistence runtime, the real server, the real SQLite file.
 */
import { flushSync } from "svelte";
import { proxy } from "svelte/internal/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database, character } from "../database.svelte";

// `sqlBootstrap` reaches `platform.ts`, which reads `window.matchMedia` and
// `document.referrer` at module scope. Enough of each to let the real module
// load in a node environment; nothing in the path under test consults them.
const nodeGlobal = globalThis as Record<string, unknown>;
nodeGlobal.window ??= { matchMedia: () => ({ matches: false }) };
nodeGlobal.document ??= { referrer: "" };
nodeGlobal.navigator ??= {};

const { publishLiveDatabase, resetLiveDatabaseForTesting } = await import("./liveDatabase");
const { NodeSqliteStorage } = await import("./nodeSqliteStorage");
const { openExistingStandaloneSql, setActiveSqlStorageForTesting } = await import("./sqlBootstrap");
const { ensureChatMessageWindow } = await import("./sqlRuntimeHydration");
const {
  flushSqlDirtyChanges,
  markSqlMessageDirty,
  markSqlRootDirty,
  resetSqlPersistenceRuntimeForTesting,
} = await import("./sqlPersistenceRuntime");
const { createClient } = await import("../../../../test/compat/helpers/client");
const { spawnServer } = await import("../../../../test/compat/helpers/spawnServer");

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;

const CHARACTER_ID = "character-proxy-persistence";
const CHAT_ID = "chat-proxy-persistence";
const HISTORY = 12;

let server: ServerHandle;
let storage: InstanceType<typeof NodeSqliteStorage>;

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
      alternateGreetings: [],
      chatPage: 0,
      chats: [{
        id: CHAT_ID,
        name: "Chat 0",
        note: "",
        localLore: [],
        message: Array.from({ length: HISTORY }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "char",
          data: `message ${index}`,
          chatId: `${CHAT_ID}-msg-${String(index).padStart(3, "0")}`,
        })),
      }],
    }],
  } as unknown as Database;
}

/** Read the whole persisted history back out of SQL, page by page. */
async function persistedMessages(chatId: string): Promise<Array<{ chatId: string; data: string }>> {
  const rows: Array<{ chatId: string; data: string }> = [];
  let before: number | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await storage.loadChatMessageReversePage(chatId, before, 100);
    rows.unshift(...page.messages.map((message) => ({
      chatId: message.chatId!,
      data: String(message.data ?? ""),
    })));
    if (!page.hasMore || page.nextBefore === null) return rows;
    before = page.nextBefore;
  }
  throw new Error("persisted history walk did not terminate");
}

describe("a change made through the live $state database, end to end", () => {
  beforeAll(async () => {
    server = await spawnServer();
    const client = await createClient(server.port, server.password);
    storage = new NodeSqliteStorage((input, init) => client.fetch(String(input), init));
    expect(await storage.init()).toBe(true);
    expect(await storage.replaceDatabase(legacyDatabase())).toBe(true);
  }, 60_000);

  afterAll(async () => {
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetLiveDatabaseForTesting();
    await server?.cleanup();
  });

  it("writes both a root setting and an appended message to SQLite", async () => {
    // `DBState`, and the one line `database.svelte` contributes at module load.
    const holder = { db: {} as Database };
    publishLiveDatabase(() => holder.db);

    // sqlBootstrap.ts:144 -- persistence is activated here, with the plain
    // object the server returned. No proxy exists yet.
    const opened = await openExistingStandaloneSql(storage);
    expect(opened?.usingSql).toBe(true);
    const stored = opened!.database;

    // bootstrap.ts:154 -- `setDatabase`, which assigns into `$state`. From here
    // `holder.db` is a proxy OF `stored`, and the two can never agree again.
    holder.db = proxy(stored);
    // Pin the fixture's defining property, not just its identity: this holder
    // is only a faithful stand-in for `DBState.db` if it does NOT write through
    // to `stored`. A fixture that quietly started writing through would make
    // every assertion below pass for the wrong reason.
    expect(holder.db).not.toBe(stored);
    (holder.db as unknown as Record<string, unknown>).__proxyProbe = "written through the proxy";
    expect((holder.db as unknown as Record<string, unknown>).__proxyProbe)
      .toBe("written through the proxy");
    expect((stored as unknown as Record<string, unknown>).__proxyProbe).toBeUndefined();

    const liveCharacter = holder.db.characters[0] as unknown as character;
    await ensureChatMessageWindow(liveCharacter, 0, 8);
    flushSync();

    // Everything below is the user, and every write goes through the proxy.
    holder.db.username = "name the user typed";
    markSqlRootDirty("username");

    const appendedId = `${CHAT_ID}-msg-appended`;
    const liveChat = liveCharacter.chats[0];
    liveChat.message.push({
      role: "user",
      data: "the message the user sent",
      chatId: appendedId,
    } as never);
    markSqlMessageDirty(CHAT_ID, appendedId);

    await flushSqlDirtyChanges();

    const reloaded = await storage.loadDatabase({ shallow: true });
    expect(reloaded?.status).toBe("ready");
    const persisted = await persistedMessages(CHAT_ID);

    // Both facts in one assertion, so a failure reports the whole loss rather
    // than stopping at whichever half is checked first.
    expect({
      username: reloaded?.database?.username,
      appendedMessage: persisted.find((row) => row.chatId === appendedId)?.data ?? null,
      messageCount: persisted.length,
    }).toEqual({
      username: "name the user typed",
      appendedMessage: "the message the user sent",
      messageCount: HISTORY + 1,
    });
  }, 60_000);
});
