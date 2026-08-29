import { safeStructuredClone } from "../../polyfill";
import { isNodeServer } from "../../platform";
import type { Database } from "../database.svelte";
import type { ISqlStorage, SqlBootstrapStorage } from "./ISqlStorage";
import { activateSqlPersistenceRuntime, deactivateSqlPersistenceRuntime, flushSqlDirtyChanges } from "./sqlPersistenceRuntime";
import { reportSqlMigrationFailure, reportSqlMigrationProgress } from "./migrationReporting";
import { WebSqliteStorage } from "./webSqliteStorage";
import { markStartupPhase } from "../../performance/startupPhases";

export interface SqlBootstrapResult {
  database: Database;
  storage: ISqlStorage | null;
  usingSql: boolean;
  migrated: boolean;
  error?: unknown;
}

export type ExistingSqlOpenResult = SqlBootstrapResult & {
  mode: "metadata-first" | "degraded" | "unsupported";
  recoveryStorage?: SqlBootstrapStorage;
};

export interface SqlBootstrapOptions {
  beforeMigrate?: () => void | Promise<void>;
}

/**
 * Select the canonical database without changing the object shape consumed by
 * existing Risu database code. A legacy snapshot is imported only when SQL is
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

    // Re-reading a freshly migrated database is not instant on a large one, and
    // it is the last thing standing between the user and a usable app.
    reportSqlMigrationProgress({
      phase: "verifying",
      chunk: 0,
      chunkCount: 0,
      statementsSent: 0,
      statementTotal: 0,
    });
    const verified = storage.backendKind === "server-sql" && "loadRecoverySnapshot" in storage
      ? await (storage as SqlBootstrapStorage).loadRecoverySnapshot()
      : await storage.loadDatabase({ shallow: false });
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
    // Keeping the legacy database usable is the right call and stays. What was
    // wrong is that it was also silent: a user whose migration could not fit in
    // one request ran in legacy mode for months, re-downloading and
    // re-uploading a 50 MB save file on every launch, and was never told. The
    // fallback is unchanged; only the silence is.
    reportSqlMigrationFailure(error);
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
let pendingSqlStorage: ISqlStorage | null = null;

async function createDefaultSqlStorage(): Promise<ISqlStorage> {
  if (!isNodeServer) return new WebSqliteStorage();

  // Keep this dynamic: globalApi constructs AutoStorage, while SQL bootstrap is
  // itself imported by database boot. A static dependency would form a cycle.
  const [{ forageStorage }, { NodeSqliteStorage }] = await Promise.all([
    import("../../globalApi.svelte"),
    import("./nodeSqliteStorage"),
  ]);
  await forageStorage.Init();
  return new NodeSqliteStorage((input, init) =>
    forageStorage.realStorage.authenticatedFetch(input, init),
  );
}

function activateSqlStorage(storage: ISqlStorage, database: Database): void {
  activeSqlStorage = storage;
  activateSqlPersistenceRuntime(storage, database);
}

/** Open an already-migrated SQL graph before touching its legacy projection. */
export async function openExistingStandaloneSql(
  storage?: ISqlStorage,
): Promise<ExistingSqlOpenResult | null> {
  try {
    storage ??= await createDefaultSqlStorage();
    // Split so the request, the rebuild and the baseline are separable: one
    // "sql-metadata" number cannot say whether startup is waiting on the wire,
    // on building objects, or on fingerprinting them.
    if (!(await storage.init())) return null;
    markStartupPhase("sql-fetch");
    const loaded = await storage.loadDatabase({ shallow: true });
    markStartupPhase("sql-rebuild");
    if (loaded?.status === "ready" && loaded.database) {
      pendingSqlStorage = null;
      activateSqlStorage(storage, loaded.database);
      markStartupPhase("sql-baseline");
      return {
        database: loaded.database,
        storage,
        usingSql: true,
        migrated: false,
        mode: "metadata-first",
      };
    }
    pendingSqlStorage = storage;
    return null;
  } catch (error) {
    console.error("Could not open existing standalone SQL database", error);
    pendingSqlStorage = null;
    if (storage?.backendKind === "server-sql" && "loadRecoverySnapshot" in storage) {
      const status = httpStatus(error);
      if (status === 404) {
        return {
          database: {} as Database,
          storage: null,
          usingSql: false,
          migrated: false,
          mode: "unsupported",
          error,
        };
      }
      if (status !== undefined && (status < 500 || status > 599)) {
        return {
          database: {} as Database,
          storage: null,
          usingSql: false,
          migrated: false,
          mode: "unsupported",
          error,
        };
      }
      return {
        database: {} as Database,
        storage: null,
        usingSql: false,
        migrated: false,
        mode: "degraded",
        recoveryStorage: storage as SqlBootstrapStorage,
        error,
      };
    }
    return null;
  }
}

export function activateRecoveredSqlStorage(storage: ISqlStorage, database: Database): void {
  activateSqlStorage(storage, database);
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = Number(error.status);
  return Number.isInteger(status) ? status : undefined;
}

export async function openStandaloneSql(
  legacyDatabase: Database,
  options?: SqlBootstrapOptions,
): Promise<SqlBootstrapResult> {
  const result = await selectCanonicalDatabase(
    pendingSqlStorage ?? await createDefaultSqlStorage(),
    legacyDatabase,
    options,
  );
  pendingSqlStorage = null;
  if (result.usingSql && result.storage) {
    activateSqlStorage(result.storage, result.database);
  } else {
    activeSqlStorage = null;
    deactivateSqlPersistenceRuntime();
  }
  return result;
}

export function getActiveSqlStorage(): ISqlStorage | null {
  return activeSqlStorage;
}

/** Serialize row-level commits so all writers share one monotonic revision. */
export function syncActiveSqlDatabase(database: Database): Promise<void> {
  // Kept as a compatibility facade for callers outside the normal mutation
  // path. Normal persistence is registry-driven and holds the live reference.
  if (activeSqlStorage) activateSqlPersistenceRuntime(activeSqlStorage, database);
  return flushSqlDirtyChanges();
}

export function setActiveSqlStorageForTesting(storage: ISqlStorage | null): void {
  activeSqlStorage = storage;
  if (!storage) deactivateSqlPersistenceRuntime();
  pendingSqlStorage = null;
}
