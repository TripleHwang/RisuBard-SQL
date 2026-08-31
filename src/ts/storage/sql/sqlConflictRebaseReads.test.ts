import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteStorage } from "./nodeSqliteStorage";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import {
    activateSqlPersistenceRuntime,
    flushSqlDirtyChanges,
    markSqlPresetDirty,
    markSqlRootDirty,
    resetSqlPersistenceRuntimeForTesting,
} from "./sqlPersistenceRuntime";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

/**
 * What a revision conflict actually costs.
 *
 * `rebaseDirtyScopes` issues one targeted read per dirty scope after a 409.
 * Three of those reads -- `loadSettingKey`, `loadPluginCustomStorageKey` and
 * `loadBotPreset` -- used to go through `this.current()`, which is
 * `loadDatabase({ shallow: true })`, which is the whole bootstrap: every
 * setting, every preset, every plugin row and a summary of every character and
 * chat. `sendStatements` drops the cached payload on the 409 that got us here,
 * so the first of those reads always refetched it. On the reporting user's
 * database that fetch was measured at 2.9-3.3 seconds -- three seconds of dead
 * time to re-read one settings row that the retry then overwrites anyway,
 * because the rebase is last-local-wins and discards everything it reads.
 *
 * `loadChat` was given its own route for exactly this reason in v0.3.14, and
 * its test says why: "a rebase that reads a summary is a rebase that learns
 * nothing". These three are the rest of that list.
 */

const openServers: { root: string; server: { close(): void } }[] = [];

afterEach(() => {
    resetSqlPersistenceRuntimeForTesting();
    resetDeferredRootKeys();
    // Closed here rather than at the end of each case: a case that fails an
    // assertion never reaches its own `close()`, and Windows refuses to remove
    // a directory holding an open SQLite handle.
    for (const { root, server } of openServers.splice(0)) {
        try { server.close(); } catch { /* already closed */ }
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

function createClient() {
    const root = mkdtempSync(join(tmpdir(), "risu-sql-rebase-"));
    const server = createRelationalSqlite({ dataRoot: root });
    openServers.push({ root, server });
    const requests: string[] = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        requests.push(path);
        if (path.startsWith("/api/sql/bootstrap")) {
            const defer = new URL(path, "https://risu.invalid").searchParams.get("defer");
            return Response.json(server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] }));
        }
        if (path.startsWith("/api/sql/root-keys/")) {
            const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
            const result = server.loadRootKey(key);
            return result.present
                ? Response.json(result)
                : Response.json({ error: "Root key not found", key, present: false }, { status: 404 });
        }
        if (path === "/api/sql/snapshot") return Response.json(server.dump());
        if (path === "/api/sql/commit") {
            try {
                return Response.json(server.commit(JSON.parse(String(init?.body))));
            } catch (error: any) {
                if (error?.code === "SQL_REVISION_CONFLICT") {
                    return Response.json({ currentRevision: error.currentRevision }, { status: 409 });
                }
                throw error;
            }
        }
        throw new Error(`Unexpected request: ${path}`);
    };
    return { client: new NodeSqliteStorage(request), requests, server };
}

function seedDatabase() {
    return {
        username: "이름",
        mainPrompt: "본문",
        pluginCustomStorage: { "plugin-a": { count: 1 }, "plugin-b": "값" },
        botPresets: [
            { id: "preset-1", name: "첫 번째" },
            { id: "preset-2", name: "두 번째" },
        ],
        botPresetsId: 0,
        characters: [{
            chaId: "character-1",
            name: "캐릭터",
            chats: [{ id: "chat-1", name: "대화", message: [{ chatId: "message-1", role: "user", data: "안녕" }] }],
        }],
    } as any;
}

const bootstrapFetches = (requests: string[]) =>
    requests.filter(path => path.startsWith("/api/sql/bootstrap")).length;

describe("the reads a revision conflict makes", () => {
    it("reads one root key from its own route, not out of the bootstrap", async () => {
        const { client, requests, server } = createClient();
        await client.replaceDatabase(seedDatabase());
        await client.init();
        requests.splice(0);

        const value = await client.loadSettingKey("username");

        expect(value).toBe("이름");
        expect(requests).toEqual(["/api/sql/root-keys/username"]);
        expect(bootstrapFetches(requests)).toBe(0);
    });

    it("reads one preset from its own route, not out of the bootstrap", async () => {
        const { client, requests, server } = createClient();
        await client.replaceDatabase(seedDatabase());
        await client.init();
        requests.splice(0);

        const preset = await client.loadBotPreset("preset-2");

        expect(preset).toMatchObject({ id: "preset-2", name: "두 번째" });
        expect(bootstrapFetches(requests)).toBe(0);
        expect(await client.loadBotPreset("no-such-preset")).toBeNull();
    });

    it("reads one plugin storage key without the bootstrap", async () => {
        const { client, requests, server } = createClient();
        await client.replaceDatabase(seedDatabase());
        await client.init();
        requests.splice(0);

        const value = await client.loadPluginCustomStorageKey("plugin-a");

        expect(value).toEqual({ count: 1 });
        expect(bootstrapFetches(requests)).toBe(0);
    });

    /**
     * A key that is not stored reads as `undefined`, exactly as it did when
     * this went through the bootstrap projection and the property was simply
     * absent. It must never become an error -- a rejection here aborts the
     * rebase and therefore the retry -- and it must never become a deletion:
     * the rebase discards what it reads, and the dirty mark is what decides
     * what gets written.
     */
    it("reads a key that is not stored as undefined rather than failing the rebase", async () => {
        const { client, server } = createClient();
        await client.replaceDatabase(seedDatabase());
        await client.init();

        expect(await client.loadSettingKey("neverStoredKey")).toBeUndefined();
        expect(await client.loadPluginCustomStorageKey("no-such-plugin-key")).toBeUndefined();
    });

    it("costs no bootstrap fetch when a settings change hits a revision conflict", async () => {
        const { client, requests, server } = createClient();
        const database = seedDatabase();
        await client.replaceDatabase(database);
        await client.init();
        activateSqlPersistenceRuntime(client as any, database);

        // Another writer moves the revision on, so our commit is stale.
        server.commit({ baseRevision: client.getRevision(), action: "other-writer", statements: [] });
        requests.splice(0);

        database.username = "새 이름";
        database.mainPrompt = "새 본문";
        markSqlRootDirty("username");
        markSqlRootDirty("mainPrompt");
        markSqlPresetDirty("preset-1");
        await flushSqlDirtyChanges();

        // One rejected commit, three targeted reads, one accepted commit.
        expect(bootstrapFetches(requests)).toBe(0);
        expect(requests.filter(path => path === "/api/sql/commit")).toHaveLength(2);
        expect(requests.filter(path => path.startsWith("/api/sql/root-keys/")).sort()).toEqual([
            "/api/sql/root-keys/botPresets",
            "/api/sql/root-keys/mainPrompt",
            "/api/sql/root-keys/username",
        ]);
        // And the local value won, which is the whole contract of the rebase.
        expect(server.loadRootKey("username").value).toBe("새 이름");
    });

    it("costs no bootstrap fetch when three conflicts happen in a row", async () => {
        const { client, requests, server } = createClient();
        const database = seedDatabase();
        await client.replaceDatabase(database);
        await client.init();
        activateSqlPersistenceRuntime(client as any, database);
        requests.splice(0);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            server.commit({ baseRevision: client.getRevision(), action: "other-writer", statements: [] });
            database.username = `이름 ${attempt}`;
            markSqlRootDirty("username");
            await flushSqlDirtyChanges();
        }

        expect(bootstrapFetches(requests)).toBe(0);
        expect(server.loadRootKey("username").value).toBe("이름 2");
    });
});
