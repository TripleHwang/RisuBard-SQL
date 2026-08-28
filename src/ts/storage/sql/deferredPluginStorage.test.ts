import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteStorage, DEFERRED_BOOTSTRAP_ROOT_KEYS } from "./nodeSqliteStorage";
import {
  deferredRootDeleteRefusals,
  isRootKeyDeferred,
  markRootKeyDeferred,
  resetDeferredRootKeys,
} from "./deferredRootKeys";
import {
  activateSqlPersistenceRuntime,
  auditSqlCompatibilityDatabase,
  flushSqlDirtyChanges,
  initializeSqlCompatibilityBaseline,
  markSqlPluginStorageDirty,
  markSqlRootDirty,
  resetSqlPersistenceRuntimeForTesting,
} from "./sqlPersistenceRuntime";
import { setActiveSqlStorageForTesting } from "./sqlBootstrap";
import { ensureRootKeyHydrated } from "./sqlRuntimeHydration";
import { buildSqlReplaceCommit } from "./sqlCommit";
import type { Database } from "../database.svelte";

/**
 * `pluginCustomStorage` is the first root key this fork actually defers, and it
 * is the key whose rows a previous version of the dirty-commit builder deleted
 * outright. Everything here drives the REAL save path -- real client, real
 * `flushSqlDirtyChanges`, real SQLite server -- and asserts on the rows that
 * survive in the database file, not on source text.
 */

const STORED_PLUGIN_STORAGE = {
  "pagefold.config.v1": { provider: "google", packagingMode: "maximum" },
  "loremaster.disabled.character:abc": { one: { key: "k", comment: "c" } },
  "translator.cache.v2": ["a", "b", "c"],
};

type Harness = {
  storage: NodeSqliteStorage;
  server: { close(): void; bootstrap(options?: unknown): any; loadRootKey(key: string): any; commit(body: unknown): any };
  database: Database;
  storedPluginStorage(): Record<string, unknown>;
};

const roots: string[] = [];
const servers: { close(): void }[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

function createServerClient(deferRootKeys?: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "risu-deferred-plugin-storage-"));
  roots.push(root);
  const server = createRelationalSqlite({ dataRoot: root });
  servers.push(server);
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/sql/bootstrap")) {
      const url = new URL(path, "https://risu.invalid");
      const defer = url.searchParams.get("defer");
      return Response.json(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
    }
    if (path.startsWith("/api/sql/root-keys/")) {
      const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
      const result = server.loadRootKey(key);
      return result.present
        ? Response.json(result)
        : Response.json({ error: "Root key not found", key, present: false }, { status: 404 });
    }
    if (path === "/api/sql/commit") {
      return Response.json(server.commit(JSON.parse(String(init?.body))));
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const storage = deferRootKeys
    ? new NodeSqliteStorage(request, deferRootKeys)
    : new NodeSqliteStorage(request);
  return { storage, server };
}

/**
 * Seeds a real SQLite database with plugin storage rows, then reopens it the
 * way the app does at startup: a bootstrap that asks for `pluginCustomStorage`
 * to be withheld.
 */
async function openWithStoredPluginStorage(deferRootKeys?: readonly string[]): Promise<Harness> {
  const { storage, server } = createServerClient(deferRootKeys);
  await storage.init();
  await storage.replaceDatabase({
    username: "standalone",
    plugins: [{ name: "installed", enabled: true }],
    pluginCustomStorage: { ...STORED_PLUGIN_STORAGE },
    botPresets: [],
    botPresetsId: 0,
    characters: [],
  } as any);
  // A fresh client: `replaceDatabase` above cleared the deferral registry the
  // same way a migration would, and the reopen is what the app really does.
  resetDeferredRootKeys();
  const database = (await storage.loadDatabase())?.database as Database;
  return {
    storage,
    server,
    database,
    storedPluginStorage: () => JSON.parse(JSON.stringify(server.loadRootKey("pluginCustomStorage").value ?? {})),
  };
}

beforeEach(() => {
  resetDeferredRootKeys();
  resetSqlPersistenceRuntimeForTesting();
  setActiveSqlStorageForTesting(null);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  resetSqlPersistenceRuntimeForTesting();
  setActiveSqlStorageForTesting(null);
  resetDeferredRootKeys();
  // Windows keeps the SQLite file locked until the handle is closed, so the
  // temp directory cannot be removed before that.
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pluginCustomStorage bootstrap deferral", () => {
  it("is the key this build actually defers", () => {
    expect([...DEFERRED_BOOTSTRAP_ROOT_KEYS]).toContain("pluginCustomStorage");
  });

  it("leaves the property off the database rather than shipping an empty map", async () => {
    const { database } = await openWithStoredPluginStorage();

    expect(isRootKeyDeferred("pluginCustomStorage")).toBe(true);
    // Not `{}` and not an own `undefined`: absent entirely, so no read site can
    // enumerate it and conclude the user has no plugin storage.
    expect(Object.prototype.hasOwnProperty.call(database, "pluginCustomStorage")).toBe(false);
    expect((database as any).username).toBe("standalone");
  });

  it("stops asking the server to withhold the map once it has been loaded", async () => {
    const { storage, database } = await openWithStoredPluginStorage();
    setActiveSqlStorageForTesting(storage);
    await ensureRootKeyHydrated(database, "pluginCustomStorage");

    // A commit invalidates the cached payload, so the app refetches. The map is
    // already in memory; withholding it again would only leave every later
    // rebuild missing a map this client already has.
    const refetched = (await storage.loadDatabase())?.database as Database;

    expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
    expect(refetched.pluginCustomStorage).toEqual(STORED_PLUGIN_STORAGE);
  });

  it("does not defer the key when the database genuinely has no plugin storage", async () => {
    const { storage, server } = createServerClient();
    await storage.init();
    await storage.replaceDatabase({
      username: "standalone", pluginCustomStorage: {}, botPresets: [], botPresetsId: 0, characters: [],
    } as any);
    resetDeferredRootKeys();

    const database = (await storage.loadDatabase())?.database as Database;

    // No rows means the server can make a definite negative statement, so the
    // client gets a real (empty) map and normal delete semantics.
    expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
    expect(database.pluginCustomStorage).toEqual({});
    expect(server.loadRootKey("pluginCustomStorage").present).toBe(false);
  });
});

describe("a full save cycle while pluginCustomStorage is deferred", () => {
  it("leaves every stored plugin storage row untouched", async () => {
    const { storage, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);
    initializeSqlCompatibilityBaseline(database);

    // The shape of the incident: something concluded a plugin storage key
    // changed while the map was not resident, so it entered the dirty set.
    for (const key of Object.keys(STORED_PLUGIN_STORAGE)) markSqlPluginStorageDirty(key);
    // An unrelated real edit rides along in the same batch and must still land.
    (database as any).username = "renamed";
    markSqlRootDirty("username");

    await flushSqlDirtyChanges();

    expect(storedPluginStorage()).toEqual(STORED_PLUGIN_STORAGE);
    expect(deferredRootDeleteRefusals().map((refusal) => refusal.origin))
      .toContain("buildSqlDirtyCommit:pluginStorage");
    expect(isRootKeyDeferred("pluginCustomStorage")).toBe(true);
  });

  it("still commits the unrelated root edits batched alongside the refusal", async () => {
    const { storage, server, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);
    initializeSqlCompatibilityBaseline(database);

    for (const key of Object.keys(STORED_PLUGIN_STORAGE)) markSqlPluginStorageDirty(key);
    (database as any).username = "renamed";
    markSqlRootDirty("username");

    await flushSqlDirtyChanges();

    expect(server.loadRootKey("username").value).toBe("renamed");
    expect(storedPluginStorage()).toEqual(STORED_PLUGIN_STORAGE);
  });

  // Named for what it actually proves. `pluginCustomStorage` is in
  // ROOT_EXCLUSIONS (sqlDirtyCommit.ts:12), so buildSqlDirtyCommit skips it at
  // line 103 and the deferral guard below is never reached. This test therefore
  // covers the exclusion, NOT the guard -- deferredRootKeys.test.ts covers the
  // guard with keys that do reach it. Naming it after the guard would leave a
  // green test standing over an unprotected path.
  it("is kept out of the root commit by ROOT_EXCLUSIONS even when marked dirty", async () => {
    const { storage, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);
    initializeSqlCompatibilityBaseline(database);

    markSqlRootDirty("pluginCustomStorage");
    await flushSqlDirtyChanges();

    expect(storedPluginStorage()).toEqual(STORED_PLUGIN_STORAGE);
  });

  it("never lets the idle compatibility audit mark a deferred plugin key dirty", async () => {
    const { storage, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);

    // Baseline taken while the map was resident, then the key becomes deferred:
    // the plugins map "loses" every key without a single row being deleted.
    // Diffing the two is precisely partial knowledge read as a definite
    // negative, so the audit must refuse to diff at all.
    (database as any).pluginCustomStorage = { ...STORED_PLUGIN_STORAGE };
    initializeSqlCompatibilityBaseline(database);
    delete (database as any).pluginCustomStorage;
    markRootKeyDeferred("pluginCustomStorage");

    auditSqlCompatibilityDatabase(database);
    await flushSqlDirtyChanges();

    expect(storedPluginStorage()).toEqual(STORED_PLUGIN_STORAGE);
  });

  it("does not re-upsert every row as a change when the key finally loads", async () => {
    const { storage, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);
    setActiveSqlStorageForTesting(storage);
    initializeSqlCompatibilityBaseline(database);

    await ensureRootKeyHydrated(database, "pluginCustomStorage");
    auditSqlCompatibilityDatabase(database);
    await flushSqlDirtyChanges();

    // Loading is not editing. The rows are unchanged either way, but a load
    // that reads as "everything changed" would rewrite hundreds of rows on
    // every startup.
    expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
    expect(database.pluginCustomStorage).toEqual(STORED_PLUGIN_STORAGE);
    expect(storedPluginStorage()).toEqual(STORED_PLUGIN_STORAGE);
  });

  it("persists a real edit normally once the key is resident", async () => {
    const { storage, database, storedPluginStorage } = await openWithStoredPluginStorage();
    activateSqlPersistenceRuntime(storage, database);
    setActiveSqlStorageForTesting(storage);
    initializeSqlCompatibilityBaseline(database);

    await ensureRootKeyHydrated(database, "pluginCustomStorage");
    auditSqlCompatibilityDatabase(database);
    database.pluginCustomStorage["pagefold.config.v1"] = { provider: "openrouter" };
    delete database.pluginCustomStorage["translator.cache.v2"];
    auditSqlCompatibilityDatabase(database);
    await flushSqlDirtyChanges();

    expect(storedPluginStorage()).toEqual({
      "pagefold.config.v1": { provider: "openrouter" },
      "loremaster.disabled.character:abc": STORED_PLUGIN_STORAGE["loremaster.disabled.character:abc"],
    });
  });
});

describe("full-replacement commits", () => {
  it("refuses to build a replace-all commit from a deferred plugin storage map", async () => {
    const { database } = await openWithStoredPluginStorage();

    // `replaceAll` clears `plugin_custom_storage` before rewriting it. Doing
    // that from a map we never loaded would delete every row.
    expect(() => buildSqlReplaceCommit(database, 0)).toThrow(/pluginCustomStorage/);
  });
});
