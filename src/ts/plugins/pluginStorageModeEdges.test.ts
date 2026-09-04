/**
 * The edges where per-key plugin storage meets everything else.
 *
 * The per-key design's own suite covers the happy paths: a v3-only launch that
 * fetches nothing, a v2.1 launch that fetches everything, reads and writes and
 * enumeration while the map is never resident. These are the seams BETWEEN
 * those states, and each one here was a live defect when it was written.
 *
 *  A. A stored key longer than the per-key route's 256-character bound.
 *     Plugin storage keys are not length-bounded on the way IN -- they reach
 *     SQLite as bind parameters through the commit path -- but every SQL read
 *     ROUTE bounds its key. So a key a plugin has been reading for years
 *     answered 400, and the plugin saw a hard failure on data that is still
 *     there. It falls back to the whole map now: slow, and correct.
 *
 *  B. A per-key read still in flight when the whole map arrives. Its answer
 *     landed in an overlay that had already been drained and would never be
 *     drained again, and the commit builder trusted that stale entry over the
 *     resident map -- turning a later `removeItem` into an upsert of the value
 *     from before the removal. The row came back with no error anywhere.
 *
 *  G. The same race around `clear()`, whose key-list fetch is its one await.
 *     Recording the removals into a drained overlay left every row in place
 *     while the plugin was told the store had been emptied.
 *
 * C, D and E pin what must NOT change: storage is one global namespace shared
 * across plugins, `version: 2` is legacy exactly as `'2.1'` is, and the
 * synchronous v2 surface throws rather than reporting an empty store when it
 * is reached while the map is not resident.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const hadImageBitmap = "ImageBitmap" in globalThis;
if (!hadImageBitmap) (globalThis as any).ImageBitmap = class ImageBitmap {};

const LONG_KEY = "libra.memory." + "x".repeat(300);

const STORED: Record<string, unknown> = {
    "libra.config": { provider: "google", depth: 4 },
    "shared.between.plugins": { note: "written by A" },
    [LONG_KEY]: { big: true },
};

const roots: string[] = [];
const servers: { close(): void }[] = [];
let consoleError: any;
let consoleWarn: any;
let fetchStub: any;

type Harness = {
    storage: NodeSqliteStorage;
    server: any;
    database: Database;
    gate: { hold(): void; release(): void; holdList(): void; releaseList(): void };
    stored(): Record<string, unknown>;
};

async function openStore(plugins: Partial<RisuPlugin>[]): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), "risu-adv-plugin-storage-"));
    roots.push(root);
    const server = createRelationalSqlite({ dataRoot: root });
    servers.push(server);

    let held: Promise<void> | null = null;
    let releaseHeld: (() => void) | null = null;
    let heldList: Promise<void> | null = null;
    let releaseHeldList: (() => void) | null = null;

    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const respond = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (path.startsWith("/api/sql/bootstrap")) {
            const url = new URL(path, "https://risu.invalid");
            const defer = url.searchParams.get("defer");
            return respond(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
        }
        if (path === "/api/sql/plugin-storage") {
            if (heldList) await heldList;
            return respond(server.listPluginStorageKeys());
        }
        if (path.startsWith("/api/sql/plugin-storage/")) {
            const key = decodeURIComponent(path.slice("/api/sql/plugin-storage/".length));
            if (held) await held;
            let result: any;
            try {
                result = server.loadPluginStorageKey(key);
            } catch (error) {
                // Mirrors normalizeSqlReadKey rejecting the key at the route.
                return respond({ error: "Invalid key" }, 400);
            }
            return result.present ? respond(result) : respond({ error: "not found", key, present: false }, 404);
        }
        if (path.startsWith("/api/sql/root-keys/")) {
            const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
            const result = server.loadRootKey(key);
            return result.present
                ? respond(result)
                : respond({ error: "Root key not found", key, present: false }, 404);
        }
        if (path === "/api/sql/commit") return respond(server.commit(JSON.parse(String(init?.body))));
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
    resetDeferredRootKeys();
    const database = (await storage.loadDatabase())?.database as Database;
    setActiveSqlStorageForTesting(storage);
    DBState.db = database as any;
    activateSqlPersistenceRuntime(storage, () => getDatabase());
    initializeSqlCompatibilityBaseline(getDatabase());

    return {
        storage, server, database,
        gate: {
            hold() { held = new Promise<void>((resolve) => { releaseHeld = resolve; }); },
            release() { releaseHeld?.(); held = null; },
            holdList() { heldList = new Promise<void>((resolve) => { releaseHeldList = resolve; }); },
            releaseList() { releaseHeldList?.(); heldList = null; },
        },
        stored: () => JSON.parse(JSON.stringify(server.loadRootKey("pluginCustomStorage").value ?? {})),
    };
}

const base = (name: string): Partial<RisuPlugin> => ({
    name, id: `id-${name}`, enabled: true, script: "",
    arguments: {}, realArg: {}, customLink: [], argMeta: {},
});
const v20Plugin = (name: string): Partial<RisuPlugin> => ({ ...base(name), version: 2 });
const v3Plugin = (name: string): Partial<RisuPlugin> => ({ ...base(name), version: "3.0" });

function iframeFor(index: number): HTMLIFrameElement {
    return [...document.querySelectorAll("iframe")][index] as HTMLIFrameElement;
}

async function callOn(iframe: HTMLIFrameElement, method: string, args: unknown[]) {
    const contentWindow = iframe.contentWindow as unknown as Window;
    const posted: any[] = [];
    const spy = vi.spyOn(contentWindow as any, "postMessage")
        .mockImplementation((message: any) => { posted.push(message); });
    try {
        window.dispatchEvent(new MessageEvent("message", {
            source: contentWindow,
            data: { type: "CALL_ROOT", reqId: `req_${method}_${Math.random()}`, method, args },
        }));
        for (let i = 0; i < 400 && posted.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    } finally { spy.mockRestore(); }
    if (posted.length === 0) throw new Error(`v3 call ${method} never answered`);
    if (posted[0].error) throw new Error(String(posted[0].error));
    return posted[0].result;
}

/** Start a call without waiting for it, returning a promise for its answer. */
function startCall(iframe: HTMLIFrameElement, method: string, args: unknown[]) {
    return callOn(iframe, method, args);
}

beforeEach(() => {
    resetDeferredRootKeys();
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        if (url.includes("/api/sql/")) throw new Error(`unexpected SQL call through global fetch: ${url}`);
        return new Response(JSON.stringify({ status: "success", token: "test" }), {
            status: 200, headers: { "content-type": "application/json" },
        });
    });
});

afterEach(async () => {
    await loadV3Plugins([]);
    document.body.replaceChildren();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    fetchStub.mockRestore();
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetDeferredRootKeys();
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a stored key longer than the per-key route's bound", () => {
    it("is read from memory when a legacy plugin forced the whole load", async () => {
        await openStore([v20Plugin("legacy")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(false);
        const api = getV2PluginAPIs() as any;
        expect(api.pluginStorage.getItem(LONG_KEY)).toEqual({ big: true });
    });

    it("falls back to the whole map rather than failing the read", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);
        // The stored value, not a rejection and above all not `null`: the row
        // is there, and a plugin told otherwise re-initialises over it.
        expect(await callOn(iframeFor(0), "_getPluginStorage", [LONG_KEY])).toEqual({ big: true });
        // Enumeration lists it either way, so a key that could not be read
        // would be one the plugin can see and not fetch.
        expect(await callOn(iframeFor(0), "_keysPluginStorage", [])).toContain(LONG_KEY);
    });
});

describe("a per-key read in flight when the whole map arrives", () => {
    it("cannot leave residue that resurrects a later deletion", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);

        // 1. Start a per-key read and stall it inside the transport.
        harness.gate.hold();
        const pending = startCall(iframeFor(0), "_getPluginStorage", ["libra.config"]);

        // 2. While it is in flight, something hydrates the whole map
        //    (the storage viewer, asset cleanup, a local backup...).
        const { ensureRootKeyHydrated } = await import("../storage/sql/sqlRuntimeHydration");
        await ensureRootKeyHydrated(getDatabase(), "pluginCustomStorage");
        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);

        // 3. The read lands after the drain and caches into a dead overlay.
        harness.gate.release();
        expect(await pending).toEqual({ provider: "google", depth: 4 });

        // 4. Now the plugin removes that key through the (now resident) path.
        await callOn(iframeFor(0), "_removePluginStorage", ["libra.config"]);
        await flushSqlDirtyChanges();

        // The removal must stick. If the stale overlay entry wins, the row is
        // silently resurrected with the pre-removal value.
        expect(harness.server.loadPluginStorageKey("libra.config").present).toBe(false);
    });
});

describe("one plugin's write read by another", () => {
    it("plugin B sees plugin A's unflushed write, and the stored row after a flush", async () => {
        const harness = await openStore([v3Plugin("a-v3"), v3Plugin("b-v3")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        await executePluginV3({ ...v3Plugin("a-v3"), script: "" } as RisuPlugin);
        await executePluginV3({ ...v3Plugin("b-v3"), script: "" } as RisuPlugin);
        const [a, b] = [iframeFor(0), iframeFor(1)];

        await callOn(a, "_setPluginStorage", ["shared.between.plugins", { note: "written by A" , v: 2 }]);
        expect(await callOn(b, "_getPluginStorage", ["shared.between.plugins"]))
            .toEqual({ note: "written by A", v: 2 });

        await flushSqlDirtyChanges();
        expect(harness.server.loadPluginStorageKey("shared.between.plugins").value)
            .toEqual({ note: "written by A", v: 2 });
    });
});

describe("a v2.0 record (version 2, not '2.1')", () => {
    it("forces the whole load and keeps the synchronous surface identical", async () => {
        await openStore([v20Plugin("legacy-2.0"), v3Plugin("modern")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(false);
        expect(isRootKeyDeferred("pluginCustomStorage")).toBe(false);
        const api = getV2PluginAPIs() as any;
        const value = api.pluginStorage.getItem("libra.config");
        expect(value).not.toBeInstanceOf(Promise);
        expect(value).toEqual({ provider: "google", depth: 4 });
        expect(api.pluginStorage.length()).toBe(Object.keys(STORED).length);
    });
});

describe("the synchronous v2 surface while per-key mode is on", () => {
    it("throws rather than reporting an empty store", async () => {
        await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        const api = getV2PluginAPIs() as any;
        expect(() => api.pluginStorage.getItem("libra.config")).toThrow(/not loaded/);
        expect(() => api.pluginStorage.keys()).toThrow(/not loaded/);
        expect(() => api.pluginStorage.length()).toThrow(/not loaded/);
        expect(() => api.pluginStorage.clear()).toThrow(/not loaded/);
        expect(() => (api.getDatabase() as any).pluginCustomStorage).toThrow(/not loaded/);
    });
});


describe("a clear() whose key-list fetch overlaps a whole-map hydrate", () => {
    it("still empties the store rather than reporting success over untouched rows", async () => {
        const harness = await openStore([v3Plugin("libra-v3")]);
        await loadPlugins();
        expect(isPluginStoragePerKeyMode()).toBe(true);
        await executePluginV3({ ...v3Plugin("libra-v3"), script: "" } as RisuPlugin);

        harness.gate.holdList();
        const pending = startCall(iframeFor(0), "_clearPluginStorage", []);
        const { ensureRootKeyHydrated } = await import("../storage/sql/sqlRuntimeHydration");
        await ensureRootKeyHydrated(getDatabase(), "pluginCustomStorage");
        harness.gate.releaseList();
        await pending;
        await flushSqlDirtyChanges();

        expect(harness.stored()).toEqual({});
    });
});
