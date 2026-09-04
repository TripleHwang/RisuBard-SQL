/**
 * Per-key plugin storage, driven through the real loading path.
 *
 * The whole design turns on one asymmetry: the v2.0/v2.1 storage API is
 * synchronous and therefore needs the entire `pluginCustomStorage` map resident
 * before a plugin's first line runs, while the v3 API crosses a `postMessage`
 * bridge and is asynchronous by construction. So these tests are organised
 * around what a plugin's recorded `version` is allowed to cost, and every one
 * of them uses a REAL `NodeSqliteStorage` against a REAL relational SQLite
 * database, with every byte of every response counted.
 *
 * What must not regress, and is asserted here rather than argued:
 *   - a v2.1 plugin sees exactly what it sees today, synchronously;
 *   - a record with no `version` is legacy, and costs the full load;
 *   - one legacy plugin among v3 ones is enough to force the full load;
 *   - nothing ever answers `null` for a key that is stored;
 *   - enumeration sees every stored key, not the ones this session touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteStorage } from "../storage/sql/nodeSqliteStorage";
import { isRootKeyDeferred, resetDeferredRootKeys } from "../storage/sql/deferredRootKeys";
import {
    activateSqlPersistenceRuntime,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
} from "../storage/sql/sqlPersistenceRuntime";
import { setActiveSqlStorageForTesting } from "../storage/sql/sqlBootstrap";
import { isPluginStoragePerKeyMode } from "../storage/sql/pluginStorageOverlay";
import { DBState } from "../stores.svelte";
import { getV2PluginAPIs, loadPlugins, type RisuPlugin } from "./plugins.svelte";
import { executePluginV3, loadV3Plugins } from "./apiV3/v3.svelte";
import { getDatabase, type Database } from "../storage/database.svelte";

const { createRelationalSqlite } = require("../../../server/node/relational-sqlite.cjs");

// `collectTransferables` in the sandbox bridge names `ImageBitmap` unguarded and
// happy-dom has no such global. Nothing here depends on its behaviour, only on
// the identifier resolving.
const hadImageBitmap = "ImageBitmap" in globalThis;
if (!hadImageBitmap) (globalThis as any).ImageBitmap = class ImageBitmap {};

/**
 * A plugin store big enough that the difference between "fetch the map" and
 * "fetch one row" is unmistakable in the byte counts below, while staying small
 * enough to build in a test. Shaped like the reported one: a handful of keys
 * holding large blobs, the way a long-term-memory plugin accumulates them.
 */
const MEMORY_BLOB = "A".repeat(64 * 1024);
const STORED: Record<string, unknown> = {
    "libra.memory.v1": { entries: Array.from({ length: 8 }, (_, i) => ({ id: i, text: MEMORY_BLOB })) },
    "flashback.index": { chunks: Array.from({ length: 8 }, (_, i) => ({ id: i, text: MEMORY_BLOB })) },
    "hypaplus.summaries": { summaries: Array.from({ length: 8 }, (_, i) => ({ id: i, text: MEMORY_BLOB })) },
    "libra.config": { provider: "google", depth: 4 },
    // A stored `null`. Nothing may flatten this into "you never stored this".
    "libra.cursor": null,
    // A falsy stored value. The resident `getItem` is `map[key] || null`, so it
    // answers `null` here; per-key mode must answer the SAME thing, or a plugin
    // would see different values depending on what else is installed.
    "libra.counter": 0,
};

const roots: string[] = [];
const servers: { close(): void }[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let fetchStub: ReturnType<typeof vi.spyOn>;

type Harness = {
    storage: NodeSqliteStorage;
    server: any;
    database: Database;
    /** Response bytes, per request path, since the last `traffic.reset()`. */
    traffic: { bytes(): number; paths(): string[]; reset(): void };
    storedPluginStorage(): Record<string, unknown>;
};

async function openStore(plugins: Partial<RisuPlugin>[]): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), "risu-per-key-plugin-storage-"));
    roots.push(root);
    const server = createRelationalSqlite({ dataRoot: root });
    servers.push(server);

    let bytes = 0;
    const paths: string[] = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        paths.push(path);
        const respond = (body: unknown, status = 200) => {
            const text = JSON.stringify(body);
            bytes += text.length;
            return new Response(text, { status, headers: { "content-type": "application/json" } });
        };
        if (path.startsWith("/api/sql/bootstrap")) {
            const url = new URL(path, "https://risu.invalid");
            const defer = url.searchParams.get("defer");
            return respond(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
        }
        if (path === "/api/sql/plugin-storage") {
            return respond(server.listPluginStorageKeys());
        }
        if (path.startsWith("/api/sql/plugin-storage/")) {
            const key = decodeURIComponent(path.slice("/api/sql/plugin-storage/".length));
            const result = server.loadPluginStorageKey(key);
            return result.present
                ? respond(result)
                : respond({ error: "Plugin storage key not found", key, present: false }, 404);
        }
        if (path.startsWith("/api/sql/root-keys/")) {
            const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
            const result = server.loadRootKey(key);
            return result.present
                ? respond(result)
                : respond({ error: "Root key not found", key, present: false }, 404);
        }
        if (path === "/api/sql/commit") {
            return respond(server.commit(JSON.parse(String(init?.body))));
        }
        throw new Error(`unexpected request: ${path}`);
    };

    const storage = new NodeSqliteStorage(request as any);
    await storage.init();
    await storage.replaceDatabase({
        username: "standalone",
        plugins: plugins as RisuPlugin[],
        pluginCustomStorage: { ...STORED },
        botPresets: [],
        botPresetsId: 0,
        characters: [],
    } as any);
    // A fresh client, the way the app really reopens: `replaceDatabase` cleared
    // the deferral registry, and the bootstrap below is what re-establishes it.
    resetDeferredRootKeys();
    const database = (await storage.loadDatabase())?.database as Database;

    setActiveSqlStorageForTesting(storage);
    // `DBState.db` is a $state proxy that does not write through to the object
    // it wraps, so the persistence runtime is pointed at the SAME proxy the
    // plugin runtime reads and writes through. Pointing it at the pre-proxy
    // object instead is what the runtime's own comments call the original
    // defect: every commit would be built from boot-time values.
    DBState.db = database as any;
    activateSqlPersistenceRuntime(storage, () => getDatabase());
    initializeSqlCompatibilityBaseline(getDatabase());

    bytes = 0;
    paths.length = 0;
    return {
        storage,
        server,
        database,
        traffic: {
            bytes: () => bytes,
            paths: () => [...paths],
            reset: () => { bytes = 0; paths.length = 0; },
        },
        storedPluginStorage: () =>
            JSON.parse(JSON.stringify(server.loadRootKey("pluginCustomStorage").value ?? {})),
    };
}

/**
 * Every fixture carries an `id` so `ensurePluginIdentities` has nothing to
 * backfill: its fire-and-forget `requestImmediateSave()` reaches the node file
 * backend, which has nothing to do with what is under test here.
 */
const base = (name: string): Partial<RisuPlugin> => ({
    name, id: `id-${name}`, enabled: true, script: "",
    arguments: {}, realArg: {}, customLink: [], argMeta: {},
});
const v2Plugin = (name: string): Partial<RisuPlugin> => ({ ...base(name), version: "2.1" });
const v3Plugin = (name: string): Partial<RisuPlugin> => ({ ...base(name), version: "3.0" });
/** A record written before `version` existed. Legacy by definition. */
const versionlessPlugin = (name: string): Partial<RisuPlugin> => base(name);

/**
 * Drive one call through the REAL v3 sandbox bridge, against the REAL API
 * object `executePluginV3` builds -- the same `CALL_ROOT` the guest's
 * `risuai.pluginStorage.getItem(...)` produces.
 */
async function v3Call(pluginName: string, method: string, args: unknown[]) {
    const iframes = [...document.querySelectorAll("iframe")];
    const iframe = iframes[iframes.length - 1] as HTMLIFrameElement;
    const contentWindow = iframe.contentWindow as unknown as Window;
    const posted: any[] = [];
    const spy = vi.spyOn(contentWindow as any, "postMessage")
        .mockImplementation((message: any) => { posted.push(message); });
    try {
        window.dispatchEvent(new MessageEvent("message", {
            source: contentWindow,
            data: { type: "CALL_ROOT", reqId: `req_${method}_${Math.random()}`, method, args },
        }));
        for (let i = 0; i < 200 && posted.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    } finally {
        spy.mockRestore();
    }
    if (posted.length === 0) throw new Error(`v3 call ${method} never answered`);
    if (posted[0].error) throw new Error(String(posted[0].error));
    return posted[0].result;
}

beforeEach(() => {
    resetDeferredRootKeys();
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    /*
     * Executing a v2.1 plugin brings up the node file backend, which probes
     * `/api/test_auth` on load. That has nothing to do with plugin storage --
     * every SQL read under test goes through the `request` function this
     * harness hands `NodeSqliteStorage` -- but with no server listening the
     * probe's rejection surfaces as a test failure. Answered here, and any
     * OTHER unexpected URL still rejects loudly rather than being swallowed.
     */
    fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        // Every SQL read under test goes through the harness `request`, never
        // through global fetch, so one reaching here is a real surprise.
        if (url.includes("/api/sql/")) throw new Error(`unexpected SQL call through global fetch: ${url}`);
        return new Response(JSON.stringify({ status: "success", token: "test" }), {
            status: 200, headers: { "content-type": "application/json" },
        });
    });
});

afterEach(async () => {
    // The real teardown: loading an empty v3 set unloads every running
    // instance, which is what `loadPlugins` itself does on every reload.
    await loadV3Plugins([]);
    document.body.replaceChildren();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    fetchStub.mockRestore();
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetDeferredRootKeys();
    // Windows keeps the SQLite file locked until the handle is closed.
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
    if (!hadImageBitmap) delete (globalThis as any).ImageBitmap;
});

/** Bytes of the whole map, as the root-key hydrate would carry it. */
function wholeMapBytes(harness: Harness): number {
    return JSON.stringify(harness.server.loadRootKey("pluginCustomStorage")).length;
}

describe("what the recorded plugin version costs at startup", () => {
    it("loads the entire map for a v2.1 plugin, exactly as before", async () => {
        const harness = await openStore([v2Plugin("libra-v2")]);

        await loadPlugins();

        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
        expect(harness.traffic.paths()).toContain("/api/sql/root-keys/pluginCustomStorage");
        // The synchronous surface answers from memory, unchanged.
        const api = getV2PluginAPIs() as any;
        expect(api.pluginStorage.getItem("libra.config")).toEqual({ provider: "google", depth: 4 });
        expect(api.pluginStorage.getItem("libra.config")).not.toBeInstanceOf(Promise);
        // The resident coercion the per-key path is pinned to.
        expect(api.pluginStorage.getItem("libra.counter")).toBeNull();
        expect(api.pluginStorage.keys().sort()).toEqual(Object.keys(STORED).sort());
        expect(api.pluginStorage.length()).toBe(Object.keys(STORED).length);
    });

    it("treats a record with no version as legacy and loads the entire map", async () => {
        const harness = await openStore([versionlessPlugin("ancient")]);

        await loadPlugins();

        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(harness.traffic.paths()).toContain("/api/sql/root-keys/pluginCustomStorage");
        // Read through `getDatabase()`, not the pre-proxy object: `DBState.db`
        // is a `$state` proxy and does not write through to what it wraps.
        expect(getDatabase().pluginCustomStorage).toEqual(STORED);
    });

    it("lets one legacy plugin among v3 ones force the full load", async () => {
        const harness = await openStore([v3Plugin("libra-v3"), v2Plugin("libra-v2")]);

        await loadPlugins();

        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(harness.traffic.paths()).toContain("/api/sql/root-keys/pluginCustomStorage");
    });

    it("fetches no plugin storage at all when every enabled plugin is v3", async () => {
        const harness = await openStore([v3Plugin("libra-v3"), v3Plugin("flashback-v3")]);

        await loadPlugins();

        expect(isPluginStoragePerKeyMode()).toBe(true);
        // The map is still deferred, which is what keeps every whole-map reader
        // (dirty commit, audit, delta, asset scan, backup) refusing rather than
        // reading a partial map as a complete one.
        expect(isRootKeyDeferred("pluginCustomStorage")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(harness.database, "pluginCustomStorage")).toBe(false);
        expect(harness.traffic.paths()).not.toContain("/api/sql/root-keys/pluginCustomStorage");
        expect(harness.traffic.paths().filter((p) => p.startsWith("/api/sql/plugin-storage"))).toEqual([]);
    });

    it("measures the difference: a v3-only launch downloads none of the store", async () => {
        const legacy = await openStore([v2Plugin("libra-v2")]);
        const wholeMap = wholeMapBytes(legacy);
        await loadPlugins();
        const legacyBytes = legacy.traffic.bytes();

        // Tear the first harness down before opening the second.
        for (const server of servers.splice(0)) server.close();
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
        resetDeferredRootKeys();
        resetSqlPersistenceRuntimeForTesting();

        const lazy = await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        const lazyBytes = lazy.traffic.bytes();

        // The fixture really is large, so this is not a rounding difference.
        expect(wholeMap).toBeGreaterThan(1_000_000);
        expect(legacyBytes).toBeGreaterThan(1_000_000);
        expect(lazyBytes).toBe(0);
        console.info(
            `[measured] startup plugin-storage bytes: legacy(v2.1)=${legacyBytes} ` +
            `v3-only=${lazyBytes} whole-map-payload=${wholeMap}`,
        );
    });
});

describe("a v3 plugin reading and writing while the map is never loaded", () => {
    async function lazySession(harness: Harness) {
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);
    }

    it("reads a stored key one row at a time, and never answers null for it", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);
        harness.traffic.reset();

        expect(await v3Call("libra-v3", "_getPluginStorage", ["libra.config"]))
            .toEqual({ provider: "google", depth: 4 });

        const paths = harness.traffic.paths();
        expect(paths).toContain("/api/sql/plugin-storage/libra.config");
        expect(paths).not.toContain("/api/sql/root-keys/pluginCustomStorage");
        // One row, not the store.
        expect(harness.traffic.bytes()).toBeLessThan(wholeMapBytes(harness) / 10);
    });

    it("answers a large key without pulling its neighbours", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);
        harness.traffic.reset();

        const value = await v3Call("libra-v3", "_getPluginStorage", ["libra.memory.v1"]) as any;
        expect(value.entries).toHaveLength(8);
        expect(value.entries[0].text).toBe(MEMORY_BLOB);

        expect(harness.traffic.paths()).toEqual(["/api/sql/plugin-storage/libra.memory.v1"]);
        // Roughly one third of the store: the other two blob keys were not read.
        expect(harness.traffic.bytes()).toBeLessThan(wholeMapBytes(harness) * 0.5);
    });

    it("keeps a stored null a value, not an absence", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        // `present: true, value: null`. A plugin that read this as "never
        // stored" would re-initialise over a cursor it still has.
        expect(await v3Call("libra-v3", "_getPluginStorage", ["libra.cursor"])).toBeNull();
        expect(harness.server.loadPluginStorageKey("libra.cursor").present).toBe(true);
    });

    it("answers a falsy stored value exactly as the resident path does", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        // Per-key mode: `0` is stored, and the resident `getItem` would coerce
        // it to `null`, so this must too. Reproducing a latent coercion bug is
        // deliberate -- diverging from it would make the answer depend on which
        // other plugins are installed, which no plugin could cope with.
        expect(await v3Call("libra-v3", "_getPluginStorage", ["libra.counter"])).toBeNull();
        // The row itself is untouched and still holds the real value.
        expect(harness.server.loadPluginStorageKey("libra.counter"))
            .toMatchObject({ present: true, value: 0 });
    });

    it("answers null only for a key the server says is not stored", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        expect(await v3Call("libra-v3", "_getPluginStorage", ["never-written"])).toBeNull();
        expect(harness.server.loadPluginStorageKey("never-written").present).toBe(false);
    });

    it("refuses rather than answering null when the per-key read fails", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);
        vi.spyOn(harness.storage, "readPluginStorageKey").mockRejectedValue(new Error("offline"));

        await expect(v3Call("libra-v3", "_getPluginStorage", ["libra.config"])).rejects.toThrow("offline");
    });

    it("persists a write to SQLite even though the audit never sees the map", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        await v3Call("libra-v3", "_setPluginStorage", ["libra.config", { provider: "anthropic", depth: 9 }]);
        await flushSqlDirtyChanges();

        expect(harness.server.loadPluginStorageKey("libra.config").value)
            .toEqual({ provider: "anthropic", depth: 9 });
        // Every other row is untouched: a per-key write is a per-key commit.
        expect(harness.storedPluginStorage()["flashback.index"]).toEqual(STORED["flashback.index"]);
    });

    it("reads back its own unflushed write instead of refetching the old row", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        await v3Call("libra-v3", "_setPluginStorage", ["libra.config", { provider: "anthropic" }]);
        expect(await v3Call("libra-v3", "_getPluginStorage", ["libra.config"]))
            .toEqual({ provider: "anthropic" });
    });

    it("commits a removal as a row delete, not as a refused deferred delete", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession(harness);

        await v3Call("libra-v3", "_removePluginStorage", ["libra.config"]);
        await flushSqlDirtyChanges();

        expect(harness.server.loadPluginStorageKey("libra.config").present).toBe(false);
        // A removal is an explicit act by the plugin, so it deletes; the other
        // rows, which nobody touched, are still there.
        expect(Object.keys(harness.storedPluginStorage()).sort())
            .toEqual(Object.keys(STORED).filter((k) => k !== "libra.config").sort());
    });
});

describe("enumeration must see every key or refuse", () => {
    async function lazySession() {
        await loadPlugins();
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);
    }

    it("lists every stored key, not the ones this session happened to touch", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession();

        // Touch exactly one key first. A design that answered enumeration from
        // its own cache would report a store of one.
        await v3Call("libra-v3", "_getPluginStorage", ["libra.config"]);

        const keys = await v3Call("libra-v3", "_keysPluginStorage", []) as string[];
        expect(keys.sort()).toEqual(Object.keys(STORED).sort());
        expect(await v3Call("libra-v3", "_lengthPluginStorage", [])).toBe(Object.keys(STORED).length);
        expect(await v3Call("libra-v3", "_keyPluginStorage", [0])).toBe(keys.sort()[0]);
        expect(harness.traffic.paths()).toContain("/api/sql/plugin-storage");
    });

    it("keeps the key list in step with writes and removals made since it was fetched", async () => {
        await openStore([v3Plugin("libra-v3")]);
        await lazySession();

        await v3Call("libra-v3", "_keysPluginStorage", []);
        await v3Call("libra-v3", "_setPluginStorage", ["libra.new", 1]);
        await v3Call("libra-v3", "_removePluginStorage", ["libra.config"]);

        const keys = await v3Call("libra-v3", "_keysPluginStorage", []) as string[];
        expect(keys).toContain("libra.new");
        expect(keys).not.toContain("libra.config");
    });

    it("clears every stored row, including keys this session never read", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession();

        await v3Call("libra-v3", "_clearPluginStorage", []);
        await flushSqlDirtyChanges();

        // The failure this guards against is a clear that deletes only the
        // touched keys and reports success, leaving the rest of the store.
        expect(harness.storedPluginStorage()).toEqual({});
        expect(await v3Call("libra-v3", "_lengthPluginStorage", [])).toBe(0);
    });

    it("refuses enumeration rather than reporting an empty store when the list read fails", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await lazySession();
        vi.spyOn(harness.storage, "listPluginCustomStorageKeys").mockRejectedValue(new Error("offline"));

        await expect(v3Call("libra-v3", "_keysPluginStorage", [])).rejects.toThrow("offline");
    });
});

describe("leaving per-key mode", () => {
    it("folds unflushed per-key writes on top of the map that arrives", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);

        await v3Call("libra-v3", "_setPluginStorage", ["libra.config", { provider: "anthropic" }]);
        await v3Call("libra-v3", "_removePluginStorage", ["libra.cursor"]);

        const { ensureRootKeyHydrated } = await import("../storage/sql/sqlRuntimeHydration");
        await ensureRootKeyHydrated(getDatabase(), "pluginCustomStorage");

        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
        // The server's map is from before these writes. Installing it alone
        // would revert them with no error anywhere.
        const merged = getDatabase().pluginCustomStorage!;
        expect(merged["libra.config"]).toEqual({ provider: "anthropic" });
        expect("libra.cursor" in merged).toBe(false);
        expect(merged["flashback.index"]).toEqual(STORED["flashback.index"]);

        // And they still persist, because their dirty marks survived the merge.
        await flushSqlDirtyChanges();
        expect(harness.server.loadPluginStorageKey("libra.config").value).toEqual({ provider: "anthropic" });
        expect(harness.server.loadPluginStorageKey("libra.cursor").present).toBe(false);
    });
});
