import { safeStructuredClone } from "../../polyfill";
import type { Database } from "../database.svelte";
import type { ISqlStorage } from "./ISqlStorage";
import { buildSqlDeltaCommit } from "./sqlDelta";
import { WebSqliteStorage } from "./webSqliteStorage";

export interface SqlBootstrapResult {
  database: Database;
  storage: ISqlStorage | null;
  usingSql: boolean;
  migrated: boolean;
  error?: unknown;
}

export interface SqlBootstrapOptions {
  beforeMigrate?: () => void | Promise<void>;
}

/**
 * Select the canonical database without changing the object shape consumed by
 * PocketRisu/RisuBard code. A legacy snapshot is imported only when SQL is
 * empty. The source is left usable when opening, migration, or verification
 * fails, which makes the transition recoverable.
 */
export async function selectCanonicalDatabase(
  storage: ISqlStorage,
  legacyDatabase: Database,
  options: SqlBootstrapOptions = {},
): Promise<SqlBootstrapResult> {
  try {
    if (!(await storage.init())) {
      return { database: legacyDatabase, storage: null, usingSql: false, migrated: false };
    }

    const loaded = await storage.loadDatabase({ shallow: false });
    if (loaded?.status === "ready" && loaded.database) {
      return {
        database: loaded.database,
        storage,
        usingSql: true,
        migrated: false,
      };
    }

    await options.beforeMigrate?.();
    const imported = await storage.replaceDatabase(
      safeStructuredClone(legacyDatabase),
    );
    if (!imported) throw new Error("SQL storage rejected the legacy database");

    const verified = await storage.loadDatabase({ shallow: false });
    if (verified?.status !== "ready" || !verified.database) {
      throw new Error("SQL migration could not be verified by reloading it");
    }
    return {
      database: verified.database,
      storage,
      usingSql: true,
      migrated: true,
    };
  } catch (error) {
    console.error("Standalone SQL bootstrap failed; preserving legacy source", error);
    return {
      database: legacyDatabase,
      storage: null,
      usingSql: false,
      migrated: false,
      error,
    };
  }
}

let activeSqlStorage: ISqlStorage | null = null;
let activeSqlBaseline: Database | null = null;
let sqlCommitChain: Promise<void> = Promise.resolve();
let pendingSqlStorage: ISqlStorage | null = null;

function activateSqlStorage(storage: ISqlStorage, database: Database): void {
  activeSqlStorage = storage;
  activeSqlBaseline = safeStructuredClone(database);
  sqlCommitChain = Promise.resolve();
}

/** Open an already-migrated SQL graph before touching its legacy projection. */
export async function openExistingStandaloneSql(
  storage: ISqlStorage = new WebSqliteStorage(),
): Promise<SqlBootstrapResult | null> {
  try {
    if (!(await storage.init())) return null;
    const loaded = await storage.loadDatabase({ shallow: false });
    if (loaded?.status === "ready" && loaded.database) {
      pendingSqlStorage = null;
      activateSqlStorage(storage, loaded.database);
      return {
        database: loaded.database,
        storage,
        usingSql: true,
        migrated: false,
      };
    }
    pendingSqlStorage = storage;
    return null;
  } catch (error) {
    console.error("Could not open existing standalone SQL database", error);
    pendingSqlStorage = null;
    return null;
  }
}

export async function openStandaloneSql(
  legacyDatabase: Database,
  options?: SqlBootstrapOptions,
): Promise<SqlBootstrapResult> {
  const result = await selectCanonicalDatabase(
    pendingSqlStorage ?? new WebSqliteStorage(),
    legacyDatabase,
    options,
  );
  pendingSqlStorage = null;
  if (result.usingSql && result.storage) {
    activateSqlStorage(result.storage, result.database);
  } else {
    activeSqlStorage = null;
    activeSqlBaseline = null;
  }
  return result;
}

export function getActiveSqlStorage(): ISqlStorage | null {
  return activeSqlStorage;
}

/** Serialize row-level commits so all writers share one monotonic revision. */
export function syncActiveSqlDatabase(database: Database): Promise<void> {
  const snapshot = safeStructuredClone(database);
  const run = async () => {
    if (!activeSqlStorage || !activeSqlBaseline) return;
    const commit = buildSqlDeltaCommit(
      activeSqlBaseline,
      snapshot,
      activeSqlStorage.getRevision(),
    );
    if (commit) await activeSqlStorage.commit(commit);
    activeSqlBaseline = snapshot;
  };
  sqlCommitChain = sqlCommitChain.then(run, run);
  return sqlCommitChain;
}

export function setActiveSqlStorageForTesting(storage: ISqlStorage | null): void {
  activeSqlStorage = storage;
  activeSqlBaseline = null;
  sqlCommitChain = Promise.resolve();
  pendingSqlStorage = null;
}
