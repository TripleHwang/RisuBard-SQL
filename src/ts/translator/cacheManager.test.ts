import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, unknown>());
const removedKeys = vi.hoisted(() => [] as string[]);
const failures = vi.hoisted(() => ({
    writeKeys: new Set<string>(),
    removeKeys: new Set<string>(),
    clearAfter: null as number | null,
}));
const readStats = vi.hoisted(() => ({ active: 0, maxActive: 0 }));
const asyncControls = vi.hoisted(() => ({
    readGate: null as Promise<void> | null,
    gatedReadsRemaining: 0,
    writeGates: new Map<string, Promise<void>>(),
    startedWrites: new Set<string>(),
}));
const requestChatDataMock = vi.hoisted(() => vi.fn());
const databaseMock = vi.hoisted(() => ({
    translatorType: "llm",
    characters: [],
}));

vi.mock("../storage/persistentKv", () => ({
    clearPersistentPrefix: vi.fn(async (prefix: string) => {
        let removed = 0;
        for (const key of [...storage.keys()]) {
            if (!key.startsWith(prefix)) continue;
            storage.delete(key);
            removed++;
            if (failures.clearAfter !== null && removed >= failures.clearAfter) {
                throw new Error("clear failed");
            }
        }
    }),
    listPersistentKeys: vi.fn(async (prefix = "") =>
        [...storage.keys()].filter((key) => key.startsWith(prefix)),
    ),
    makeHashedStorageKey: vi.fn(async (prefix: string, key: string) =>
        `${prefix}${encodeURIComponent(key)}.json`,
    ),
    readPersistentJson: vi.fn(async (key: string) => {
        readStats.active++;
        readStats.maxActive = Math.max(readStats.maxActive, readStats.active);
        const value = storage.get(key);
        const readGate = asyncControls.gatedReadsRemaining > 0
            ? asyncControls.readGate
            : null;
        if (readGate) asyncControls.gatedReadsRemaining--;
        await Promise.resolve();
        if (readGate) await readGate;
        try {
            if (value instanceof Error) throw value;
            return value ?? null;
        } finally {
            readStats.active--;
        }
    }),
    removePersistentKey: vi.fn(async (key: string) => {
        if (failures.removeKeys.has(key)) throw new Error("delete failed");
        removedKeys.push(key);
        storage.delete(key);
    }),
    writePersistentJson: vi.fn(async (key: string, value: unknown) => {
        if (failures.writeKeys.has(key)) throw new Error("write failed");
        asyncControls.startedWrites.add(key);
        const gate = asyncControls.writeGates.get(key);
        if (gate) await gate;
        storage.set(key, value);
    }),
}));

vi.mock("svelte/store", () => ({ get: vi.fn(() => 0) }));
vi.mock("../parser/chatML", () => ({ parseChatML: vi.fn() }));
vi.mock("../storage/database.svelte", () => ({ getDatabase: vi.fn(() => databaseMock) }));
vi.mock("./presets", () => ({
    defaultTranslatorPrompt: "",
    getCurrentTranslatorPresetFromState: vi.fn(() => ({ prompt: "", maxResponse: 100 })),
}));
vi.mock("../globalApi.svelte", () => ({ globalFetch: vi.fn() }));
vi.mock("../alert", () => ({ notifyError: vi.fn() }));
vi.mock("../process/request/request", () => ({ requestChatData: requestChatDataMock }));
vi.mock("../process/index.svelte", () => ({ doingChat: {} }));
vi.mock("../parser/parser.svelte", () => ({ applyMarkdownToNode: vi.fn() }));
vi.mock("../stores.svelte", () => ({ selectedCharID: {} }));
vi.mock("../process/modules", () => ({ getModuleRegexScripts: vi.fn() }));
vi.mock("../util", () => ({ getNodetextToSentence: vi.fn(), sleep: vi.fn() }));
vi.mock("../process/scripts", () => ({ processScriptFull: vi.fn() }));
vi.mock("../notificationSound", () => ({ playNotificationSound: vi.fn() }));

import {
    clearLLMCache,
    deleteLLMCache,
    exportLLMCacheAsJSON,
    getLLMCache,
    importLLMCacheFromJSON,
    listLLMCache,
    runTranslator,
    searchLLMCache,
    setLLMCache,
    updateLLMCacheValue,
} from "./translator";

const prefix = "cache/llm-translate/";

function seed(key: string, value: string, storageKey = `${prefix}${encodeURIComponent(key)}.json`) {
    storage.set(storageKey, { key, value });
    return storageKey;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

async function startDelayedTranslation(key: string) {
    const response = deferred<{ type: string, result: string }>();
    requestChatDataMock.mockImplementationOnce(() => response.promise);
    const result = runTranslator(key, false, "ko", "en");
    await vi.waitFor(() => expect(requestChatDataMock).toHaveBeenCalled());
    return { result, response };
}

describe("LLM translation cache manager", () => {
    beforeEach(async () => {
        storage.clear();
        removedKeys.length = 0;
        failures.writeKeys.clear();
        failures.removeKeys.clear();
        failures.clearAfter = null;
        readStats.active = 0;
        readStats.maxActive = 0;
        asyncControls.readGate = null;
        asyncControls.gatedReadsRemaining = 0;
        asyncControls.writeGates.clear();
        asyncControls.startedWrites.clear();
        requestChatDataMock.mockReset();
        await clearLLMCache();
    });

    it("lists, searches, sorts, and paginates rows deterministically", async () => {
        seed("Zulu", "끝");
        seed("alpha", "FIRST");
        const bravoStorageKey = seed("Bravo", "Second result");
        seed("charlie", "third result");

        const firstPage = await listLLMCache({ page: 1, pageSize: 2 });
        expect(firstPage).toEqual({
            rows: [
                { key: "alpha", value: "FIRST", storageKey: `${prefix}alpha.json` },
                { key: "Bravo", value: "Second result", storageKey: bravoStorageKey },
            ],
            total: 4,
            page: 1,
            pageSize: 2,
            pageCount: 2,
        });

        const valueMatch = await listLLMCache({ search: "SECOND", page: 1 });
        expect(valueMatch.rows.map((row) => row.key)).toEqual(["Bravo"]);
        expect(valueMatch.pageSize).toBe(100);
    });

    it("updates the value while retaining the exact key and storage key", async () => {
        const storageKey = seed("Key With Spaces", "old");

        await updateLLMCacheValue("Key With Spaces", "new", storageKey);

        expect(storage.get(storageKey)).toEqual({ key: "Key With Spaces", value: "new" });
        expect(await getLLMCache("Key With Spaces")).toBe("new");
        expect((await listLLMCache()).rows[0].storageKey).toBe(storageKey);
    });

    it("updates and deletes through the exact listed persistent storage key", async () => {
        const storageKey = seed("legacy key", "old", `${prefix}legacy-storage.json`);

        await updateLLMCacheValue("legacy key", "new", storageKey);
        expect(storage.get(storageKey)).toEqual({ key: "legacy key", value: "new" });
        expect(storage.has(`${prefix}legacy%20key.json`)).toBe(false);

        await deleteLLMCache("legacy key", storageKey);
        expect(storage.has(storageKey)).toBe(false);
        expect(removedKeys).toContain(storageKey);
    });

    it("updates an existing legacy storage location without creating a canonical duplicate", async () => {
        const legacyStorageKey = seed("legacy direct", "old", `${prefix}legacy-direct.json`);

        await setLLMCache("legacy direct", "new");

        expect(storage.get(legacyStorageKey)).toEqual({ key: "legacy direct", value: "new" });
        expect(storage.has(`${prefix}legacy%20direct.json`)).toBe(false);
    });

    it("imports over an existing legacy storage location without duplicating it", async () => {
        const legacyStorageKey = seed("legacy import", "old", `${prefix}legacy-import.json`);

        await expect(importLLMCacheFromJSON({ "legacy import": "new" })).resolves.toEqual({ count: 1, failed: 0 });

        expect(storage.get(legacyStorageKey)).toEqual({ key: "legacy import", value: "new" });
        expect(storage.has(`${prefix}legacy%20import.json`)).toBe(false);
    });

    it("deletes every duplicate physical row so the logical key cannot reappear", async () => {
        seed("duplicate", "legacy", `${prefix}legacy-duplicate.json`);
        seed("duplicate", "canonical", `${prefix}duplicate.json`);
        const listed = await listLLMCache();

        await deleteLLMCache("duplicate", listed.rows[0].storageKey);

        expect([...storage.values()].filter((value: any) => value?.key === "duplicate")).toEqual([]);
        expect((await listLLMCache()).rows).toEqual([]);
    });

    it("consistently prefers a canonical row over conflicting legacy duplicates", async () => {
        seed("conflict", "legacy", `${prefix}legacy-conflict.json`);
        const canonicalStorageKey = seed("conflict", "canonical");

        await expect(getLLMCache("conflict")).resolves.toBe("canonical");
        await expect(listLLMCache()).resolves.toMatchObject({
            rows: [{ key: "conflict", value: "canonical", storageKey: canonicalStorageKey }],
        });
        await expect(searchLLMCache("conflict")).resolves.toEqual([
            { key: "conflict", value: "canonical" },
        ]);
        await expect(exportLLMCacheAsJSON()).resolves.toMatchObject({ conflict: "canonical" });
    });

    it("deletes one entry from memory and persistent storage", async () => {
        const storageKey = seed("remove me", "value");
        await setLLMCache("remove me", "value");

        await deleteLLMCache("remove me", storageKey);

        expect(storage.has(storageKey)).toBe(false);
        expect(removedKeys).toContain(storageKey);
        expect(await getLLMCache("remove me")).toBeNull();
    });

    it("requires the exact listed storage key and validates its payload", async () => {
        const storageKey = seed("managed", "old", `${prefix}legacy-managed.json`);
        seed("different", "value", `${prefix}different.json`);

        await expect(
            (updateLLMCacheValue as unknown as (key: string, value: string) => Promise<void>)("managed", "new"),
        ).rejects.toThrow("storage key");
        await expect(deleteLLMCache("managed", `${prefix}different.json`)).rejects.toThrow("does not match");

        expect(storage.get(storageKey)).toEqual({ key: "managed", value: "old" });
    });

    it("surfaces persistent write failure without changing the memory mirror", async () => {
        const storageKey = seed("write failure", "old");
        await listLLMCache();
        failures.writeKeys.add(storageKey);

        await expect(updateLLMCacheValue("write failure", "new", storageKey)).rejects.toThrow("write failed");

        expect(storage.get(storageKey)).toEqual({ key: "write failure", value: "old" });
        expect(await getLLMCache("write failure")).toBe("old");
    });

    it("surfaces persistent delete failure without removing the memory mirror", async () => {
        const storageKey = seed("delete failure", "value");
        await listLLMCache();
        failures.removeKeys.add(storageKey);

        await expect(deleteLLMCache("delete failure", storageKey)).rejects.toThrow("delete failed");

        expect(storage.has(storageKey)).toBe(true);
        expect(await getLLMCache("delete failure")).toBe("value");
    });

    it("clears all entries from memory and persistent storage", async () => {
        seed("one", "uno");
        await setLLMCache("two", "dos");

        await clearLLMCache();

        expect(storage.size).toBe(0);
        expect(await getLLMCache("two")).toBeNull();
        expect((await listLLMCache()).total).toBe(0);
    });

    it("returns an empty bounded page and clamps pages after filtering", async () => {
        expect(await listLLMCache({ page: 999 })).toEqual({
            rows: [],
            total: 0,
            page: 1,
            pageSize: 100,
            pageCount: 1,
        });

        seed("alpha", "one");
        seed("beta", "two");
        seed("gamma", "three");
        const result = await listLLMCache({ page: 99, pageSize: 2 });
        expect(result.page).toBe(2);
        expect(result.rows.map((row) => row.key)).toEqual(["gamma"]);
    });

    it("omits memory-only entries and evicts their stale mirrors", async () => {
        const storageKey = `${prefix}memory-only.json`;
        await setLLMCache("memory-only", "ghost");
        storage.delete(storageKey);

        expect((await listLLMCache()).rows).toEqual([]);
        expect(await getLLMCache("memory-only")).toBeNull();
    });

    it("uses persistent values and reconciles stale memory mirrors", async () => {
        const storageKey = `${prefix}stale.json`;
        await setLLMCache("stale", "old memory");
        storage.set(storageKey, { key: "stale", value: "fresh persistent" });

        expect((await listLLMCache()).rows).toEqual([
            { key: "stale", value: "fresh persistent", storageKey },
        ]);
        expect(await getLLMCache("stale")).toBe("fresh persistent");
    });

    it("reads large persistent listings concurrently within a bounded limit", async () => {
        for (let index = 0; index < 40; index++) seed(`concurrent-${index}`, `value-${index}`);

        await listLLMCache();

        expect(readStats.maxActive).toBeGreaterThan(1);
        expect(readStats.maxActive).toBeLessThanOrEqual(16);
    });

    it("caps oversized pages at 100 rows", async () => {
        for (let index = 0; index < 101; index++) {
            seed(`key-${String(index).padStart(3, "0")}`, `value-${index}`);
        }

        const result = await listLLMCache({ page: 1, pageSize: 1000 });

        expect(result.pageSize).toBe(100);
        expect(result.rows).toHaveLength(100);
        expect(result.pageCount).toBe(2);
    });

    it("skips malformed and unreadable persistent entries", async () => {
        seed("valid", "works");
        storage.set(`${prefix}malformed.json`, { key: 42, value: "bad" });
        storage.set(`${prefix}unreadable.json`, new Error("broken JSON"));

        const result = await listLLMCache();

        expect(result.rows).toEqual([
            { key: "valid", value: "works", storageKey: `${prefix}valid.json` },
        ]);
        expect(result.total).toBe(1);
    });

    it("exports valid entries when malformed or unreadable entries exist", async () => {
        seed("valid", "works");
        storage.set(`${prefix}malformed.json`, { key: 42, value: "bad" });
        storage.set(`${prefix}unreadable.json`, new Error("broken JSON"));

        await expect(exportLLMCacheAsJSON()).resolves.toEqual({ valid: "works" });
    });

    it("exports only validated persistent values and supports prototype-like keys", async () => {
        await setLLMCache("stale", "memory value");
        storage.set(`${prefix}stale.json`, { key: "stale", value: "persistent value" });
        await setLLMCache("memory-only", "ghost");
        storage.delete(`${prefix}memory-only.json`);
        seed("constructor", "ctor");
        seed("toString", "stringer");
        seed("__proto__", "proto");

        const result = await exportLLMCacheAsJSON();

        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.keys(result).sort()).toEqual(["__proto__", "constructor", "stale", "toString"].sort());
        expect(result.stale).toBe("persistent value");
        expect(result.__proto__).toBe("proto");
    });

    it("reconciles memory after a partially failed persistent clear", async () => {
        const deletedStorageKey = seed("deleted first", "gone");
        seed("survivor", "kept");
        await listLLMCache();
        failures.clearAfter = 1;

        await expect(clearLLMCache()).rejects.toThrow("clear failed");

        expect(storage.has(deletedStorageKey)).toBe(false);
        expect(await getLLMCache("deleted first")).toBeNull();
        expect(await getLLMCache("survivor")).toBe("kept");
    });

    it("retries a listing that was reading while clear completed", async () => {
        seed("read race", "old value");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        await clearLLMCache();
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({ rows: [], total: 0 });
        expect(await getLLMCache("read race")).toBeNull();
    });

    it("retries a persistent snapshot when a key changes during the read", async () => {
        await setLLMCache("edit read race", "old value");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        await setLLMCache("edit read race", "new value");
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({
            rows: [{ key: "edit read race", value: "new value" }],
        });
        expect(await getLLMCache("edit read race")).toBe("new value");
    });

    it("does not let an older listing snapshot overwrite a completed translation", async () => {
        const pending = await startDelayedTranslation("translation read race");
        seed("translation read race", "old persistent");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const listing = listLLMCache();
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));

        pending.response.resolve({ type: "success", result: "new translation" });
        await pending.result;
        asyncControls.readGate = null;
        gate.resolve();

        await expect(listing).resolves.toMatchObject({
            rows: [{ key: "translation read race", value: "new translation" }],
        });
        expect(await getLLMCache("translation read race")).toBe("new translation");
    });

    it("prevents an import started before clear from repopulating afterward", async () => {
        const firstStorageKey = `${prefix}first.json`;
        const gate = deferred<void>();
        asyncControls.writeGates.set(firstStorageKey, gate.promise);
        const importing = importLLMCacheFromJSON({ first: "one", second: "two" });
        await vi.waitFor(() => expect(asyncControls.startedWrites.has(firstStorageKey)).toBe(true));

        const clearing = clearLLMCache();
        gate.resolve();
        const [imported] = await Promise.all([importing, clearing]);

        expect(imported).toEqual({ count: 1, failed: 1 });
        expect(storage.size).toBe(0);
        expect((await listLLMCache()).total).toBe(0);
    });

    it("ignores an older translation result that completes after a manual edit", async () => {
        const pending = await startDelayedTranslation("late edit");
        await setLLMCache("late edit", "manual value");

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(await getLLMCache("late edit")).toBe("manual value");
        expect(storage.get(`${prefix}late%20edit.json`)).toEqual({ key: "late edit", value: "manual value" });
    });

    it("does not resurrect a key when an older translation completes after delete", async () => {
        const pending = await startDelayedTranslation("late delete");
        const storageKey = `${prefix}late%20delete.json`;
        await setLLMCache("late delete", "temporary");
        await deleteLLMCache("late delete", storageKey);

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(storage.has(storageKey)).toBe(false);
        expect(await getLLMCache("late delete")).toBeNull();
    });

    it("does not repopulate cache when an older translation completes after clear", async () => {
        const pending = await startDelayedTranslation("late clear");
        await clearLLMCache();

        pending.response.resolve({ type: "success", result: "late result" });
        await pending.result;

        expect(storage.size).toBe(0);
        expect(await getLLMCache("late clear")).toBeNull();
    });

    it("awaits and publishes a current translation result", async () => {
        const pending = await startDelayedTranslation("current result");

        pending.response.resolve({ type: "success", result: "current value" });
        await expect(pending.result).resolves.toBe("current value");

        expect(storage.get(`${prefix}current%20result.json`)).toEqual({
            key: "current result",
            value: "current value",
        });
        expect(await getLLMCache("current result")).toBe("current value");
    });

    it("keeps direct reads and searches safe around damaged entries", async () => {
        storage.set(`${prefix}damaged.json`, new Error("broken JSON"));
        storage.set(`${prefix}bad.json`, { key: "bad", value: 42 });
        seed("valid", "works");

        await expect(getLLMCache("damaged")).resolves.toBeNull();
        await expect(getLLMCache("bad")).resolves.toBeNull();
        await expect(searchLLMCache("valid")).resolves.toEqual([
            { key: "valid", value: "works" },
        ]);
    });

    it("does not let a delayed direct get repopulate memory after clear", async () => {
        seed("get clear race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const reading = getLLMCache("get clear race");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await clearLLMCache();
        gate.resolve();

        await expect(reading).resolves.toBeNull();
        expect(await getLLMCache("get clear race")).toBeNull();
    });

    it("does not let a delayed direct get overwrite a manual edit", async () => {
        seed("get edit race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const reading = getLLMCache("get edit race");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await setLLMCache("get edit race", "new");
        gate.resolve();

        await expect(reading).resolves.toBe("new");
        expect(await getLLMCache("get edit race")).toBe("new");
    });

    it("does not let a delayed search repopulate memory after clear", async () => {
        seed("search clear race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const searching = searchLLMCache("search clear");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await clearLLMCache();
        gate.resolve();

        await expect(searching).resolves.toEqual([]);
        expect(await getLLMCache("search clear race")).toBeNull();
    });

    it("does not let a delayed search overwrite a manual edit", async () => {
        seed("search edit race", "old");
        const gate = deferred<void>();
        asyncControls.readGate = gate.promise;
        asyncControls.gatedReadsRemaining = 1;
        const searching = searchLLMCache("search edit");
        await vi.waitFor(() => expect(readStats.active).toBeGreaterThan(0));
        asyncControls.readGate = null;

        await setLLMCache("search edit race", "new");
        gate.resolve();

        await expect(searching).resolves.toEqual([{ key: "search edit race", value: "new" }]);
        expect(await getLLMCache("search edit race")).toBe("new");
    });
});
