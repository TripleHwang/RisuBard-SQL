/**
 * The two things a legacy-to-SQL migration owes the user: what it is doing, and
 * what happened when it did not finish.
 *
 * Both are broadcast rather than returned because the migration runs deep
 * inside the storage client while the surfaces that show it -- the loading
 * label and the alert modal -- live in `bootstrap.ts`. Threading a callback
 * through `openStandaloneSql` -> `selectCanonicalDatabase` -> `replaceDatabase`
 * -> `commit` would put a UI parameter on every storage signature; a listener
 * registry keeps the storage layer unaware of who is watching, and keeps this
 * module a leaf with no app imports (so it can never form a cycle).
 *
 * Nothing here is allowed to turn a listener's problem into a migration
 * failure: a throwing listener is logged and the next listener still runs. That
 * is not swallowing the failure -- it is reported in full, to the one place a
 * reporting channel can report to.
 */

export interface SqlMigrationProgress {
  /**
   * `preparing`  -- flattening the legacy database into SQL statements. No
   *                 network yet, and on a large database this is the phase that
   *                 looks stuck the longest.
   * `fetching`   -- downloading the chat histories the database does not carry.
   *                 The database the client gets from `GET /api/read` has every
   *                 chat reduced to a stub, so on a real migration this is
   *                 hundreds of round trips and by far the longest stretch. It
   *                 is interleaved with `uploading`: a chat is fetched, its
   *                 messages go into the chunk being built, and it is dropped.
   * `uploading`  -- sending statement chunks; `chunk` of `chunkCount`.
   * `verifying`  -- re-reading the migrated database to prove it landed.
   */
  phase: "preparing" | "fetching" | "uploading" | "verifying";
  /** 1-based chunk being sent. 0 outside the `uploading` phase. */
  chunk: number;
  /**
   * Total chunks this migration will send, or 0 when it is not yet known.
   *
   * A migration that has to fetch its chat histories cannot know its own length
   * in advance -- the statements do not exist until the messages arrive -- and
   * saying "part 3 of 3" and then sending a fourth would be worse than saying
   * nothing. `describeSqlMigrationProgress` reports an open-ended count instead.
   */
  chunkCount: number;
  statementsSent: number;
  /** 0 while still preparing, because the statements do not exist yet. */
  statementTotal: number;
  /** 1-based chat being fetched. 0 outside the `fetching` phase. */
  chat?: number;
  /** How many chat histories this migration has to fetch. */
  chatCount?: number;
  /** Messages fetched so far, across every chat. */
  messagesFetched?: number;
}

export interface SqlMigrationFailure {
  /** The error that ended the migration, unmodified. */
  error: unknown;
  /** Ready-to-show text naming the cause and the consequence. */
  message: string;
}

type Listener<T> = (event: T) => void;

const progressListeners = new Set<Listener<SqlMigrationProgress>>();
const failureListeners = new Set<Listener<SqlMigrationFailure>>();

function emit<T>(listeners: Set<Listener<T>>, event: T, channel: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      // A broken display must not abort a migration that is otherwise fine,
      // and must not disappear either.
      console.error(
        `[SQL migration] a ${channel} listener threw; the migration is unaffected ` +
        "but this listener's surface is now stale.",
        error,
      );
    }
  }
}

/** Subscribe to migration progress. Returns the unsubscribe function. */
export function onSqlMigrationProgress(listener: Listener<SqlMigrationProgress>): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export function reportSqlMigrationProgress(progress: SqlMigrationProgress): void {
  emit(progressListeners, progress, "progress");
}

/** Subscribe to migration failures. Returns the unsubscribe function. */
export function onSqlMigrationFailure(listener: Listener<SqlMigrationFailure>): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

export function reportSqlMigrationFailure(error: unknown): SqlMigrationFailure {
  const failure: SqlMigrationFailure = {
    error,
    message: describeSqlMigrationFailure(error),
  };
  emit(failureListeners, failure, "failure");
  return failure;
}

/** Drops every listener. Test-only: module state outlives a single test. */
export function resetSqlMigrationListeners(): void {
  progressListeners.clear();
  failureListeners.clear();
}

export function sqlMigrationErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Unknown error";
  if (typeof error === "string" && error) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch (serializationError) {
    return `Unserializable error (${String(serializationError)})`;
  }
  return String(error);
}

/**
 * The loading-screen label. A migration can run for minutes, so the label has
 * to separate "still working" from "stuck": the chunk counter and the
 * percentage both move on every request.
 */
export function describeSqlMigrationProgress(progress: SqlMigrationProgress): string {
  switch (progress.phase) {
    case "preparing":
      return "Migrating to SQL: preparing the legacy database...";
    case "verifying":
      return "Migrating to SQL: verifying the migrated database...";
    case "fetching": {
      // The chat counter is the only thing that moves during the long stretch
      // where the client is downloading histories one chat at a time. Without
      // it this phase is indistinguishable from a hang.
      const chat = progress.chat ?? 0;
      const chatCount = progress.chatCount ?? 0;
      const messages = progress.messagesFetched ?? 0;
      return `Migrating to SQL: downloading chat ${chat} of ${chatCount} (${messages} messages)`;
    }
    case "uploading": {
      const percent = progress.statementTotal > 0
        ? Math.min(100, Math.floor((progress.statementsSent / progress.statementTotal) * 100))
        : 0;
      // A migration that fetches its histories does not know how many parts it
      // will take, so it reports the part it is on and nothing it cannot know.
      if (progress.chunkCount <= 0) return `Migrating to SQL: sending part ${progress.chunk}`;
      return `Migrating to SQL: part ${progress.chunk} of ${progress.chunkCount} (${percent}%)`;
    }
  }
}

/**
 * The alert text for a migration that did not finish.
 *
 * The failure this exists for was invisible: the fallback to the legacy
 * database is deliberate and correct, but for months it said nothing, so a user
 * re-downloaded and re-uploaded a 50 MB database on every launch without ever
 * being told why. Naming the cause and the running mode is the whole point.
 */
export function describeSqlMigrationFailure(error: unknown): string {
  return (
    "Migrating your database into the server's SQL storage failed, so this session is " +
    "running in legacy mode from your save file. Nothing was lost, but every launch will " +
    "keep re-downloading and re-uploading the whole save file until this is fixed.\n\n" +
    `Cause: ${sqlMigrationErrorText(error)}`
  );
}
