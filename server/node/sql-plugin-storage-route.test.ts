/**
 * The per-key plugin storage reads, at the storage layer and at the route.
 *
 * `pluginCustomStorage` is the one root key withheld from the SQL bootstrap,
 * and until now the only way to get any of it back was
 * `GET /api/sql/root-keys/pluginCustomStorage`, which returns the entire map.
 * On the stores this deferral exists for that is hundreds of megabytes to read
 * one value -- and the conflict rebase did exactly that, once per dirty key.
 *
 * The contract these tests hold to is the one the root-key route established:
 * existence and value are separate facts. `present: true` with `value: null` is
 * a stored null; `present: false` is the only answer that means the row is not
 * there. A client that collapses the two writes over data it never read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { createRelationalSqlite } = require('./relational-sqlite.cjs');
const {
    createSqlPluginStorageKeyHandler,
    createSqlPluginStorageKeyListHandler,
} = require('./sql-root-key-route.cjs');

const roots: string[] = [];
const servers: { close(): void }[] = [];

const STORED: Record<string, unknown> = {
    'libra.memory': { entries: ['one', 'two'] },
    'flashback.index': { chunks: [1, 2, 3] },
    'libra.cursor': null,
    'zeta.last': 'tail',
};

function openStore() {
    const root = mkdtempSync(join(tmpdir(), 'risu-plugin-storage-route-'));
    roots.push(root);
    const server = createRelationalSqlite({ dataRoot: root });
    servers.push(server);
    // Seeded through the server's own commit entry point, as raw statements --
    // the same shape `applySqliteCommit` produces for a plugin storage upsert.
    server.commit({
        baseRevision: server.revision(),
        action: 'sync',
        statements: Object.entries(STORED).map(([key, value]) => ({
            sql: "INSERT INTO plugin_custom_storage (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            bind: [key, JSON.stringify(value)],
        })),
    });
    return server;
}

/** Minimal express-shaped response recorder. */
function recorder() {
    const out: { status: number; body: any; headers: Record<string, string> } = {
        status: 200, body: undefined, headers: {},
    };
    const res: any = {
        status(code: number) { out.status = code; return res; },
        set(name: string, value: string) { out.headers[name] = value; return res; },
        json(body: any) { out.body = body; return res; },
    };
    return { res, out };
}

const allow = async () => true;

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadPluginStorageKey', () => {
    it('reads one row without touching its neighbours', () => {
        const server = openStore();
        const result = server.loadPluginStorageKey('libra.memory');
        expect(result.present).toBe(true);
        expect(result.value).toEqual({ entries: ['one', 'two'] });
        expect(result.key).toBe('libra.memory');
        expect(Number.isSafeInteger(result.revision)).toBe(true);
    });

    it('keeps a stored null a value, not an absence', () => {
        const server = openStore();
        const result = server.loadPluginStorageKey('libra.cursor');
        // The whole point of the discriminator: a plugin told "absent" here
        // would re-initialise over a cursor it still has.
        expect(result.present).toBe(true);
        expect(result.value).toBeNull();
    });

    it('reports a row that is not stored as absent rather than throwing', () => {
        const server = openStore();
        expect(server.loadPluginStorageKey('never-written')).toMatchObject({ present: false });
    });

    it('returns exactly what the whole-map read returns, key for key', () => {
        const server = openStore();
        const whole = server.loadRootKey('pluginCustomStorage').value;
        for (const key of Object.keys(STORED)) {
            expect(server.loadPluginStorageKey(key).value).toEqual(whole[key]);
        }
    });

    it('refuses an out-of-bounds key instead of reading something', () => {
        const server = openStore();
        expect(() => server.loadPluginStorageKey('')).toThrow(/Invalid plugin storage key/);
        expect(() => server.loadPluginStorageKey('x'.repeat(257))).toThrow(/Invalid plugin storage key/);
    });
});

describe('listPluginStorageKeys', () => {
    it('lists every key, in order, and no values', () => {
        const server = openStore();
        const result = server.listPluginStorageKeys();
        expect(result.keys).toEqual(Object.keys(STORED).sort());
        // Keys, and none of the values they name -- that is what makes this
        // route cheap enough to answer enumeration with.
        expect(JSON.stringify(result)).not.toContain('chunks');
        expect(JSON.stringify(result)).not.toContain('entries');
        expect(JSON.stringify(result.keys)).toContain('flashback.index');
        expect(JSON.stringify(result).length).toBeLessThan(
            JSON.stringify(server.loadRootKey('pluginCustomStorage')).length,
        );
    });

    it('answers an empty list for a database with no plugin storage', () => {
        const root = mkdtempSync(join(tmpdir(), 'risu-plugin-storage-route-empty-'));
        roots.push(root);
        const server = createRelationalSqlite({ dataRoot: root });
        servers.push(server);
        expect(server.listPluginStorageKeys().keys).toEqual([]);
    });
});

describe('the HTTP handlers', () => {
    it('carries present:true and the value on a hit', async () => {
        const server = openStore();
        const { res, out } = recorder();
        await createSqlPluginStorageKeyHandler({ auth: allow, relationalSql: server })(
            { params: { storageKey: 'zeta.last' } }, res, () => {},
        );
        expect(out.status).toBe(200);
        expect(out.body).toMatchObject({ present: true, key: 'zeta.last', value: 'tail' });
        expect(out.headers['Cache-Control']).toBe('no-store');
    });

    it('carries present:false in the BODY of the 404, so it cannot read as a transport failure', async () => {
        const server = openStore();
        const { res, out } = recorder();
        await createSqlPluginStorageKeyHandler({ auth: allow, relationalSql: server })(
            { params: { storageKey: 'never-written' } }, res, () => {},
        );
        expect(out.status).toBe(404);
        expect(out.body).toMatchObject({ present: false, key: 'never-written' });
    });

    it('rejects an out-of-bounds key with 400 and reads nothing', async () => {
        const server = openStore();
        const { res, out } = recorder();
        await createSqlPluginStorageKeyHandler({ auth: allow, relationalSql: server })(
            { params: { storageKey: 'x'.repeat(300) } }, res, () => {},
        );
        expect(out.status).toBe(400);
        expect(out.body).toMatchObject({ error: 'Invalid key' });
    });

    it('serves the key list', async () => {
        const server = openStore();
        const { res, out } = recorder();
        await createSqlPluginStorageKeyListHandler({ auth: allow, relationalSql: server })(
            {}, res, () => {},
        );
        expect(out.body.keys).toEqual(Object.keys(STORED).sort());
        expect(out.headers['Cache-Control']).toBe('no-store');
    });

    it('answers nothing at all when auth refuses', async () => {
        const server = openStore();
        const { res, out } = recorder();
        await createSqlPluginStorageKeyHandler({ auth: async () => false, relationalSql: server })(
            { params: { storageKey: 'zeta.last' } }, res, () => {},
        );
        expect(out.body).toBeUndefined();
    });

    it('forwards a storage failure to the error handler rather than answering absent', async () => {
        const failing = {
            loadPluginStorageKey() { throw new Error('disk gone'); },
        };
        const { res, out } = recorder();
        let forwarded: unknown;
        await createSqlPluginStorageKeyHandler({ auth: allow, relationalSql: failing })(
            { params: { storageKey: 'zeta.last' } }, res, (error: unknown) => { forwarded = error; },
        );
        // A 404 here would tell the client the row is gone.
        expect((forwarded as Error).message).toBe('disk gone');
        expect(out.body).toBeUndefined();
    });
});
