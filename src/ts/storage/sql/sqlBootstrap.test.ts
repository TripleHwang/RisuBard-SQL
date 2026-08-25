import { describe, expect, it, vi } from "vitest";

import type { ISqlStorage, SqlLoadDatabaseResult } from "./ISqlStorage";
import {
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
  it("opens existing SQL without requiring a legacy projection", async () => {
    const sql = { characters: [], username: "sql" } as any;
    const storage = fakeStorage([
      { status: "ready", revision: 4, database: sql },
    ]);

    const result = await openExistingStandaloneSql(storage);

    expect(result?.database).toBe(sql);
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
