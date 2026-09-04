/**
 * Plugin storage writes must be marked where they happen.
 *
 * The audit that preceded this change recommended narrowing the idle
 * compatibility audit so it stops re-fingerprinting every plugin storage value
 * every five seconds -- "fingerprint only keys the dirty registry named". That
 * recommendation is circular, and these tests are the evidence.
 *
 * `markSqlPluginStorageDirty` had exactly ONE caller in the whole application:
 * `auditSqlCompatibilityDatabase`. The registry does not name plugin keys; the
 * audit is what puts them there, by diffing a full re-fingerprint of the
 * resident map against the previous one. Narrow the audit to keys the registry
 * already names and nothing is ever named, so no plugin write is ever detected
 * and none is ever persisted.
 *
 * The audit therefore cannot be narrowed that way -- but the reason it had to
 * be the detector is that nothing marked at the write boundary, and that is a
 * bug on its own: until the next audit ran (up to ~10s, a 5s timer chained to
 * `requestIdleCallback({timeout: 5000})`) a plugin's `setItem` was not merely
 * unflushed, it was UNMARKED, and a flush in that window reported success while
 * writing nothing.
 *
 * These tests drive the real v2 plugin API and the real dirty-commit path, and
 * they flush WITHOUT running an audit first. Before the write-boundary marks
 * were added, every one of them committed nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteStorage } from "../storage/sql/nodeSqliteStorage";
import { resetDeferredRootKeys } from "../storage/sql/deferredRootKeys";
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
} from "../storage/sql/sqlPersistenceRuntime";
import { setActiveSqlStorageForTesting } from "../storage/sql/sqlBootstrap";
import { DBState } from "../stores.svelte";
import { getV2PluginAPIs } from "./plugins.svelte";
import { getDatabase, type Database } from "../storage/database.svelte";

const { createRelationalSqlite } = require("../../../server/node/relational-sqlite.cjs");

const STORED = {
    "libra.config": { provider: "google" },
    "libra.memory": { entries: ["one", "two"] },
    "flashback.index": { chunks: [1, 2, 3] },
};

const roots: string[] = [];
const servers: { close(): void }[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

type Harness = {
    server: any;
    stored(): Record<string, unknown>;
};

/**
 * A resident plugin storage map -- the ordinary case, no deferral involved.
 * Everything here is about the WRITE side, which is identical whether the map
 * was deferred or not.
 */
async function openResident(): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), "risu-plugin-write-marking-"));
    roots.push(root);
    const server = createRelationalSqlite({ dataRoot: root });
    servers.push(server);
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/sql/bootstrap")) {
            // No deferral: this suite is about marking, not laziness.
            return Response.json(server.bootstrap({ deferRootKeys: [] }));
        }
        if (path.startsWith("/api/sql/root-keys/")) {
            const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
            const result = server.loadRootKey(key);
            return result.present
                ? Response.json(result)
                : Response.json({ error: "Root key not found", key, present: false }, { status: 404 });
        }
        if (path === "/api/sql/commit") return Response.json(server.commit(JSON.parse(String(init?.body))));
        throw new Error(`unexpected request: ${path}`);
    };

    const storage = new NodeSqliteStorage(request as any);
    await storage.init();
    await storage.replaceDatabase({
        username: "standalone",
        plugins: [],
        pluginCustomStorage: { ...STORED },
        botPresets: [],
        botPresetsId: 0,
        characters: [],
    } as any);
    resetDeferredRootKeys();
    const database = (await storage.loadDatabase())?.database as Database;

    setActiveSqlStorageForTesting(storage);
    DBState.db = database as any;
    activateSqlPersistenceRuntime(storage, () => getDatabase());
    initializeSqlCompatibilityBaseline(getDatabase());

    return {
        server,
        stored: () => JSON.parse(JSON.stringify(server.loadRootKey("pluginCustomStorage").value ?? {})),
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
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the v2 plugin storage API marks its own writes", () => {
    it("persists setItem through a flush that runs before any audit", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;

        api.pluginStorage.setItem("libra.config", { provider: "anthropic" });
        // Deliberately NO `auditSqlCompatibilityDatabase` here. This is the
        // pagehide / saver-mode / crash window: the audit that used to be the
        // only detector has not run and may never run.
        await flushSqlDirtyChanges();

        expect(harness.stored()["libra.config"]).toEqual({ provider: "anthropic" });
    });

    it("persists removeItem as a row delete, not as a NULL value", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;

        api.pluginStorage.removeItem("libra.memory");
        await flushSqlDirtyChanges();

        // `delete` on a `$state` proxy leaves the own key behind holding
        // `undefined`. Committed as a value that would be SQL NULL against a
        // `TEXT NOT NULL` column, failing the whole batch; committed as a
        // removal it is a DELETE.
        expect("libra.memory" in harness.stored()).toBe(false);
        expect(Object.keys(harness.stored()).sort()).toEqual(["flashback.index", "libra.config"]);
    });

    it("persists clear() as the removal of every row, including untouched ones", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;

        api.pluginStorage.clear();
        await flushSqlDirtyChanges();

        // The keys have to be marked BEFORE the map is replaced: afterwards
        // there is nothing left to enumerate, and a key nobody marked is a row
        // the commit builder never visits.
        expect(harness.stored()).toEqual({});
    });

    it("persists a write made through the db proxy's custom-property path", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;
        const db = api.getDatabase();

        db["libra.newKey"] = { hello: "world" };
        await flushSqlDirtyChanges();

        expect(harness.stored()["libra.newKey"]).toEqual({ hello: "world" });
    });

    it("persists writes made through setDatabaseLite", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;

        api.setDatabaseLite({ "libra.viaLite": [1, 2, 3] });
        await flushSqlDirtyChanges();

        expect(harness.stored()["libra.viaLite"]).toEqual([1, 2, 3]);
    });

    it("leaves every other row alone: a marked write is a per-key commit", async () => {
        const harness = await openResident();
        const api = getV2PluginAPIs() as any;

        api.pluginStorage.setItem("libra.config", { provider: "anthropic" });
        await flushSqlDirtyChanges();

        expect(harness.stored()["libra.memory"]).toEqual(STORED["libra.memory"]);
        expect(harness.stored()["flashback.index"]).toEqual(STORED["flashback.index"]);
    });
});

describe("why the idle audit still cannot be narrowed to already-dirty keys", () => {
    /**
     * The boundary marks above cover every SANCTIONED write. They cannot cover
     * a plugin that took a reference out of `getDatabase()` and mutated inside
     * it, because there is no boundary to mark. That mutation is found only by
     * the audit's full re-fingerprint -- which is why the recommendation to
     * fingerprint "only keys the dirty registry names" would have silently
     * stopped persisting exactly this class of edit, and why the audit is left
     * alone by this change.
     */
    it("finds a raw in-place mutation only by re-fingerprinting the whole map", async () => {
        const harness = await openResident();
        const database = getDatabase();

        // No API call, no boundary: the plugin mutated the object it was given.
        (database.pluginCustomStorage as any)["libra.memory"].entries.push("three");

        await flushSqlDirtyChanges();
        // Nothing marked it, so nothing committed it. This is the state the
        // audit exists to repair.
        expect(harness.stored()["libra.memory"]).toEqual(STORED["libra.memory"]);

        // The full re-fingerprint is what notices, and it is the only thing
        // that does. Narrowing it to keys the registry already names would
        // leave this edit undetected forever.
        auditSqlCompatibilityDatabase(database);
        await flushSqlDirtyChanges();
        expect((harness.stored()["libra.memory"] as any).entries).toEqual(["one", "two", "three"]);
    });
});
