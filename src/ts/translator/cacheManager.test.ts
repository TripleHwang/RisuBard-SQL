import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, unknown>());
const removedKeys = vi.hoisted(() => [] as string[]);

vi.mock("../storage/persistentKv", () => ({
    clearPersistentPrefix: vi.fn(async (prefix: string) => {
        for (const key of [...storage.keys()]) {
            if (key.startsWith(prefix)) storage.delete(key);
        }
    }),
    listPersistentKeys: vi.fn(async (prefix = "") =>
        [...storage.keys()].filter((key) => key.startsWith(prefix)),
    ),
    makeHashedStorageKey: vi.fn(async (prefix: string, key: string) =>
        `${prefix}${encodeURIComponent(key)}.json`,
    ),
    readPersistentJson: vi.fn(async (key: string) => {
        const value = storage.get(key);
        if (value instanceof Error) throw value;
        return value ?? null;
    }),
    removePersistentKey: vi.fn(async (key: string) => {
        removedKeys.push(key);
        storage.delete(key);
    }),
    writePersistentJson: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
    }),
}));

vi.mock("svelte/store", () => ({ get: vi.fn() }));
vi.mock("../parser/chatML", () => ({ parseChatML: vi.fn() }));
vi.mock("../storage/database.svelte", () => ({ getDatabase: vi.fn() }));
vi.mock("./presets", () => ({
    defaultTranslatorPrompt: "",
    getCurrentTranslatorPresetFromState: vi.fn(),
}));
vi.mock("../globalApi.svelte", () => ({ globalFetch: vi.fn() }));
vi.mock("../alert", () => ({ notifyError: vi.fn() }));
vi.mock("../process/request/request", () => ({ requestChatData: vi.fn() }));
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
    listLLMCache,
    searchLLMCache,
    setLLMCache,
    updateLLMCacheValue,
} from "./translator";

const prefix = "cache/llm-translate/";

function seed(key: string, value: string, storageKey = `${prefix}${encodeURIComponent(key)}.json`) {
    storage.set(storageKey, { key, value });
    return storageKey;
}

describe("LLM translation cache manager", () => {
    beforeEach(async () => {
        storage.clear();
        removedKeys.length = 0;
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

        await updateLLMCacheValue("Key With Spaces", "new");

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

    it("deletes one entry from memory and persistent storage", async () => {
        const storageKey = seed("remove me", "value");
        await setLLMCache("remove me", "value");

        await deleteLLMCache("remove me");

        expect(storage.has(storageKey)).toBe(false);
        expect(removedKeys).toContain(storageKey);
        expect(await getLLMCache("remove me")).toBeNull();
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
});
