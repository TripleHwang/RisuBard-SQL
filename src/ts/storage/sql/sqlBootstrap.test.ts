import { describe, expect, it, vi } from "vitest";

import type { ISqlStorage, SqlBootstrapStorage, SqlLoadDatabaseResult } from "./ISqlStorage";
import {
  getActiveSqlStorage,
  activateRecoveredSqlStorage,
  openExistingStandaloneSql,
  selectCanonicalDatabase,
  setActiveSqlStorageForTesting,
} from "./sqlBootstrap";

function fakeStorage(loads: SqlLoadDatabaseResult[]): ISqlStorage {
  return {
    init: vi.fn(async () => true),
    loadDatabase: vi.fn(async () => loads.shift() ?? null),
    replaceDatabase: vi.fn(async () => true),
  } as unknown as ISqlStorage;
}

describe("standalone SQL bootstrap", () => {
  it("returns a degraded bootstrap result when Node bootstrap is unavailable", async () => {
    setActiveSqlStorageForTesting(null);
    const storage = {
      ...fakeStorage([]),
      backendKind: "server-sql" as const,
      init: vi.fn(async () => { throw Object.assign(new Error("SQL bootstrap failed (503)"), { status: 503 }); }),
      loadBootstrap: vi.fn(),
      loadRecoverySnapshot: vi.fn(),
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await openExistingStandaloneSql(storage);

    expect(result).toMatchObject({ usingSql: false, mode: "degraded", recoveryStorage: storage });
    expect(getActiveSqlStorage()).toBeNull();
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("marks a missing bootstrap endpoint as unsupported without allowing snapshot recovery", async () => {
    setActiveSqlStorageForTesting(null);
    const storage = {
      ...fakeStorage([]),
      backendKind: "server-sql" as const,
      init: vi.fn(async () => { throw Object.assign(new Error("SQL bootstrap failed (404)"), { status: 404 }); }),
      loadBootstrap: vi.fn(),
      loadRecoverySnapshot: vi.fn(),
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await openExistingStandaloneSql(storage);

    expect(result).toMatchObject({ usingSql: false, mode: "unsupported" });
    expect(result?.recoveryStorage).toBeUndefined();
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("does not recover snapshots for authentication failures", async () => {
    setActiveSqlStorageForTesting(null);
    const storage = {
      ...fakeStorage([]), backendKind: "server-sql" as const,
      init: vi.fn(async () => { throw Object.assign(new Error("SQL bootstrap failed (401)"), { status: 401 }); }),
      loadBootstrap: vi.fn(), loadRecoverySnapshot: vi.fn(), loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await openExistingStandaloneSql(storage);
    expect(result).toMatchObject({ mode: "unsupported", usingSql: false });
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("allows explicit degraded recovery for network failures without an HTTP status", async () => {
    setActiveSqlStorageForTesting(null);
    const storage = {
      ...fakeStorage([]), backendKind: "server-sql" as const,
      init: vi.fn(async () => { throw new TypeError("Failed to fetch"); }),
      loadBootstrap: vi.fn(), loadRecoverySnapshot: vi.fn(), loadCharacterHydration: vi.fn(), loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await openExistingStandaloneSql(storage);
    expect(result).toMatchObject({ mode: "degraded", recoveryStorage: storage });
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("activates recovered SQL storage so later edits retain the canonical revision", () => {
    const storage = fakeStorage([]);
    const database = { characters: [] } as any;

    activateRecoveredSqlStorage(storage, database);

    expect(getActiveSqlStorage()).toBe(storage);
    setActiveSqlStorageForTesting(null);
  });

  it("opens existing SQL without requiring a legacy projection", async () => {
    const sql = { characters: [], username: "sql" } as any;
    const storage = fakeStorage([
      { status: "ready", revision: 4, database: sql },
    ]);

    const result = await openExistingStandaloneSql(storage);

    expect(result?.database).toBe(sql);
    expect(result?.mode).toBe("metadata-first");
    expect(storage.replaceDatabase).not.toHaveBeenCalled();
    setActiveSqlStorageForTesting(null);
  });

  it("keeps an existing SQL database canonical", async () => {
    const legacy = { characters: [], username: "legacy" } as any;
    const sql = { characters: [], username: "sql" } as any;
    const storage = fakeStorage([
      { status: "ready", revision: 4, database: sql },
    ]);

    const result = await selectCanonicalDatabase(storage, legacy);

    expect(result.database).toBe(sql);
    expect(result.usingSql).toBe(true);
    expect(result.migrated).toBe(false);
    expect(storage.replaceDatabase).not.toHaveBeenCalled();
  });

  it("backs up, imports, and reload-verifies an empty SQL database", async () => {
    const legacy = { characters: [], username: "legacy" } as any;
    const verified = { characters: [], username: "legacy" } as any;
    const storage = fakeStorage([
      { status: "empty", revision: 0, database: null },
      { status: "ready", revision: 1, database: verified },
    ]);
    const beforeMigrate = vi.fn();

    const result = await selectCanonicalDatabase(storage, legacy, {
      beforeMigrate,
    });

    expect(beforeMigrate).toHaveBeenCalledOnce();
    expect(storage.replaceDatabase).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      database: verified,
      storage,
      usingSql: true,
      migrated: true,
    });
  });

  it("verifies a Node migration through lightweight bootstrap and retains the imported graph", async () => {
    const legacy = {
      username: "legacy",
      characters: [{ chaId: "character-1", chats: [{ id: "chat-1", message: [{ chatId: "message-1", data: "kept" }] }] }],
    } as any;
    const storage = {
      ...fakeStorage([{ status: "empty", revision: 0, database: null }]),
      backendKind: "server-sql" as const,
      getRevision: vi.fn(() => 1),
      loadBootstrap: vi.fn(async () => ({
        status: "ready" as const,
        revision: 1,
        settings: {},
        pluginCustomStorage: {},
        botPresets: [],
        characters: [],
        selectedCharacterId: null,
        selectedChatId: null,
      })),
      loadRecoverySnapshot: vi.fn(),
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await selectCanonicalDatabase(storage, legacy);

    expect(storage.loadBootstrap).toHaveBeenCalledOnce();
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
    expect(storage.loadDatabase).toHaveBeenCalledOnce();
    expect(storage.replaceDatabase).toHaveBeenCalledWith(result.database);
    expect(result.database).toEqual(legacy);
    expect(result.database).not.toBe(legacy);
    expect(result.database.characters[0].chaId).toBe("character-1");
    expect(result.database.characters[0].chats[0].message[0]).toMatchObject({
      chatId: "message-1", data: "kept",
    });
  });

  it("falls back to the legacy source when Node bootstrap does not confirm the committed revision", async () => {
    const legacy = { characters: [], username: "legacy" } as any;
    const storage = {
      ...fakeStorage([{ status: "empty", revision: 0, database: null }]),
      backendKind: "server-sql" as const,
      getRevision: vi.fn(() => 1),
      loadBootstrap: vi.fn(async () => ({
        status: "ready" as const,
        revision: 2,
        settings: {}, pluginCustomStorage: {}, botPresets: [], characters: [],
        selectedCharacterId: null, selectedChatId: null,
      })),
      loadRecoverySnapshot: vi.fn(),
      loadCharacterHydration: vi.fn(),
      loadChatMessageReversePage: vi.fn(),
    } as unknown as SqlBootstrapStorage;

    const result = await selectCanonicalDatabase(storage, legacy);

    expect(result).toMatchObject({ database: legacy, usingSql: false, migrated: false });
    expect(storage.loadRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("preserves the source snapshot when migration verification fails", async () => {
    const legacy = { characters: [], username: "legacy" } as any;
    const storage = fakeStorage([
      { status: "empty", revision: 0, database: null },
      { status: "empty", revision: 1, database: null },
    ]);

    const result = await selectCanonicalDatabase(storage, legacy);

    expect(result.database).toBe(legacy);
    expect(result.usingSql).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});
