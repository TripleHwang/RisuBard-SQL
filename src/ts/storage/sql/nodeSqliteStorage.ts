import { v4 as uuidv4 } from "uuid";

import type {
  BotPresetSummary,
  SqlBotChatStats,
  SqlBootstrapPayload,
  SqlBootstrapStorage,
  SqlCharacterSearchResult,
  SqlLoadDatabaseOptions,
  SqlLoadDatabaseResult,
  SqlMessagePage,
  SqlMessageSearchResult,
  SqlRevision,
  SqlReverseMessagePage,
  SqlTokenUsage,
  StoredBotPreset,
} from "./ISqlStorage";
import { markPerformance, measurePerformance } from "../../performance/startupMetrics";
import { runtimeMetrics } from "../../performance/runtimeMetrics";
import type {
  character,
  Chat,
  customscript,
  Database,
  loreBook,
  Message,
  RisuPersona,
} from "../database.svelte";
import type { RisuModule } from "../../process/modules";
import { rebuildRelationalValue } from "./relationalNodeCodec";
import {
  applySqliteCommit,
  writeSqliteColdStorage,
} from "./sqliteCommit";
import {
  buildSqlReplaceCommit,
  createEmptySqlCommit,
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import {
  clearDeferredRootKey,
  deferredRootKeySnapshot,
  markRootKeysDeferred,
} from "./deferredRootKeys";
import {
  reportSqlMigrationProgress,
  sqlMigrationErrorText,
} from "./migrationReporting";

type AuthenticatedRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ServerDump {
  status: "ready" | "empty";
  revision: number;
  tables: Record<string, Record<string, unknown>[]>;
}

type Statement = { sql: string; bind: unknown[] };

export class SqlHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SqlHttpError";
  }
}

/**
 * Per-request metadata describing one slice of a migration that spans several
 * requests.
 *
 * The field names are the server's (`server/node/sql-commit-route.cjs`), which
 * uses them to keep its own completion marker withheld until `final` lands and
 * to reject a slice that arrives out of order. A server that does not know the
 * field ignores it and applies each slice as an ordinary commit, which is why
 * the client keeps its own in-progress marker as well.
 *
 * Constraints the server enforces, all satisfied by `sendMigration` below: `id`
 * is 1..128 characters, `chunk` is a 0-based integer below `totalChunks`,
 * `totalChunks` is at least 2, and `final` is true on exactly the last chunk. A
 * migration that fits in one request sends no descriptor at all -- one chunk is
 * not a sequence, and the server rejects `totalChunks: 1`.
 */
interface SqlMigrationChunkMeta {
  /** Identifies one migration across all of its requests. */
  id: string;
  /** 0-based position of this request. */
  chunk: number;
  totalChunks: number;
  /** True on the last request, the one that completes the migration. */
  final: boolean;
}

/**
 * A 409 that is not a revision conflict.
 *
 * The commit route answers 409 for a family of migration-sequence problems
 * ("a migration is already in flight", "that is not the chunk I expect"). None
 * of them is fixed by retrying against a newer revision, so none of them may
 * arrive as `SqlRevisionConflictError` -- a caller that retries on that would
 * loop. The server's own code and message are carried through verbatim.
 */
export class SqlCommitConflictError extends Error {
  constructor(readonly code: string, message: string, readonly detail: unknown) {
    super(message);
    this.name = "SqlCommitConflictError";
  }
}

/**
 * A migration slice the server did not accept.
 *
 * Named separately from a plain commit failure because the consequence is
 * different: the SQL database now holds a partial copy. The message says so,
 * because the person reading it needs to know that the legacy database is
 * untouched and that the next launch starts over rather than adopting the
 * wreckage.
 */
export class SqlMigrationChunkError extends Error {
  constructor(
    readonly chunk: number,
    readonly chunkCount: number,
    readonly reason: unknown,
  ) {
    super(
      `SQL migration failed while sending part ${chunk} of ${chunkCount}: ` +
      `${sqlMigrationErrorText(reason)}. The SQL database holds a partial copy and stays ` +
      "marked as an unfinished migration, so it is not used; your existing save file is " +
      "unchanged and the migration starts over on the next launch.",
    );
    this.name = "SqlMigrationChunkError";
  }
}

/**
 * A non-JSON error body is normal (proxies and express both answer with HTML),
 * so failing to parse one is not a failure to report -- the raw text is used
 * verbatim instead and nothing is lost.
 */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The server's own words about why it refused a commit.
 *
 * `sendStatements` used to throw away the response body, so the one thing that
 * could explain a failed migration -- "SQL commit is too large" -- never
 * reached the user or the console; all anyone ever saw was the status code.
 */
async function serverErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    if (!body) return "";
    const parsed = parseJsonOrNull(body) as { error?: unknown } | null;
    const detail = parsed && typeof parsed === "object" && typeof parsed.error === "string" && parsed.error
      ? parsed.error
      : body;
    return `: ${detail.slice(0, 500)}`;
  } catch (error) {
    return `: <the server's error body could not be read: ${sqlMigrationErrorText(error)}>`;
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(maximum, Math.max(1, normalized));
}

function sorted(rows: Record<string, unknown>[], key = "position") {
  return [...rows].sort((left, right) => Number(left[key]) - Number(right[key]));
}

/**
 * Root keys this client asks the server to withhold from the bootstrap payload.
 *
 * Adding a key here is the entire opt-in: bootstrap stops shipping it, it
 * becomes undeletable until loaded, and `ensureRootKeyHydrated` fetches it on
 * first use.
 *
 * `pluginCustomStorage` is the first: hundreds of rows on real databases, read
 * from a small enumerable set of places (the plugin runtime, the plugin storage
 * settings page, the lorebook workspace's legacy backups, local backup export),
 * every one of which either awaits the load or refuses to answer from partial
 * knowledge.
 */
export const DEFERRED_BOOTSTRAP_ROOT_KEYS: readonly string[] = ["pluginCustomStorage"];

/**
 * Statements per request when a legacy-to-SQL migration is too big to send at
 * once.
 *
 * The server refuses a commit above its own per-request cap (250,000 today), a
 * guard on how much it will hold in memory and execute in one transaction, and
 * raising it is not the fix -- a 50 MB legacy database produces ~355,000
 * statements and there is no cap that makes "one request" the right shape.
 * This is deliberately an order of magnitude below the server's cap: it bounds
 * the JSON body (~10 MB rather than ~100 MB), so a stalled upload is noticed in
 * seconds instead of minutes, and it leaves room for the cap to be lowered
 * without this client immediately breaking.
 */
export const SQL_MIGRATION_CHUNK_STATEMENTS = 20_000;

/**
 * The root setting that says "a migration started here and has not finished".
 *
 * A chunked migration cannot be one transaction, so between its first and last
 * request the SQL database holds a partial copy -- and the server marks it
 * `initialized = 1` as soon as the first chunk lands. That flag alone would
 * therefore say "canonical" about a half-written database.
 *
 * This key is written in the same transaction as the migration's opening
 * DELETEs and cleared in the same transaction as its last chunk, so it is
 * present for exactly as long as the database is incomplete. Every load path
 * checks it and refuses to treat such a database as ready, which sends the next
 * launch back to the legacy source and migrates again from a clean slate.
 */
export const SQL_MIGRATION_MARKER_KEY = "__risuSqlMigrationInProgress";

/**
 * The statements that raise (`marker`) or clear (`null`) the in-progress mark.
 *
 * Raising it goes through `applySqliteCommit` so the row is written exactly the
 * way every other root setting is -- including its relational nodes, without
 * which the server's bootstrap would report the key as unreadable instead of
 * as a value. Clearing it removes both halves, leaving no trace on a database
 * that finished migrating.
 */
async function migrationMarkerStatements(marker: string | null): Promise<Statement[]> {
  if (marker === null) {
    return [
      { sql: "DELETE FROM system_settings WHERE key = ?", bind: [SQL_MIGRATION_MARKER_KEY] },
      {
        sql: "DELETE FROM setting_extension_nodes WHERE setting_key = ?",
        bind: [SQL_MIGRATION_MARKER_KEY],
      },
    ];
  }
  const commit = createEmptySqlCommit(0, "migration-marker");
  commit.root.upserts.push({ key: SQL_MIGRATION_MARKER_KEY, value: marker });
  const statements: Statement[] = [];
  await applySqliteCommit(commit, (sql, bind = []) => {
    statements.push({ sql, bind });
  });
  return statements;
}

/**
 * Keys `rebuildBootstrap` populates itself from dedicated payload fields *and*
 * cannot omit. They are always resident, so the server can never meaningfully
 * defer them; honouring such a request would mark a key deferred that we then
 * immediately overwrite.
 *
 * `pluginCustomStorage` is deliberately NOT in this set: `rebuildBootstrap`
 * knows how to leave its property off the object entirely when the server
 * withholds it.
 */
const STRUCTURAL_BOOTSTRAP_KEYS = new Set([
  "botPresets",
  "botPresetsId",
  "characters",
  "selectedCharacterId",
  "selectedChatId",
  "activeBotPresetId",
]);

/*
 * ---------------------------------------------------------------------------
 * TRANSPORT SHIM -- the only place that encodes the deferral wire format.
 *
 * Matched against the server routes in server/node/sql-root-key-route.cjs and
 * server/node/relational-sqlite.cjs:
 *
 *   GET /api/sql/bootstrap?defer=a,b
 *       -> the usual payload, plus deferredRootKeys / absentDeferredRootKeys /
 *          unreadableRootKeys. Only `deferredRootKeys` means "exists, withheld".
 *   GET /api/sql/root-keys/<key>
 *       -> 200 { revision, key, present: true, value }   (value may be null)
 *          404 { error, key, present: false }            (not stored at all)
 *          400 { error }                                 (key out of bounds)
 *
 * If the wire format changes again, these three helpers plus the optional
 * fields on `SqlBootstrapPayload` are the whole surface to adjust.
 * ---------------------------------------------------------------------------
 */

function bootstrapRequestPath(deferKeys: readonly string[]): string {
  const requested: string[] = [];
  for (const key of deferKeys) {
    if (!key) continue;
    // Never ask for a key we could not accept the answer for: the client
    // rebuilds these from dedicated payload fields, and `validateBootstrap`
    // requires them, so a withheld one would fail the whole bootstrap.
    if (STRUCTURAL_BOOTSTRAP_KEYS.has(key)) {
      console.error(
        `[SQL deferred bootstrap] not requesting deferral of "${key}": the client rebuilds it ` +
        "from a dedicated bootstrap field, so it cannot be withheld. Remove it from " +
        "DEFERRED_BOOTSTRAP_ROOT_KEYS.",
      );
      continue;
    }
    requested.push(key);
  }
  if (requested.length === 0) return "/api/sql/bootstrap";
  return `/api/sql/bootstrap?${new URLSearchParams({ defer: requested.join(",") })}`;
}

function rootKeyRequestPath(key: string): string {
  return `/api/sql/root-keys/${encodeURIComponent(key)}`;
}

/**
 * Reads a single-root-key response. Rejects on anything ambiguous.
 *
 * `present` and `value` are separate facts on purpose: `present: true` with
 * `value: null` is a stored null and is accepted. A 404 -- whether it carries
 * `present: false` or is a plain routing failure -- is never a value, so it
 * rejects and the caller leaves the key deferred.
 */
async function readRootKeyResponse(
  key: string,
  response: Response,
): Promise<{ revision: number; value: unknown }> {
  if (!response.ok) {
    const detail = response.status === 404
      ? "the server reports it is not stored, but a routing failure looks identical, " +
        "so the key stays deferred rather than being treated as deleted"
      : "the key stays deferred";
    throw new SqlHttpError(
      `SQL root key "${key}" load failed (${response.status}); ${detail}`,
      response.status,
    );
  }
  const payload = await response.json() as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
    !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 0 ||
    payload.present !== true ||
    (payload.key !== undefined && payload.key !== key) ||
    !Object.prototype.hasOwnProperty.call(payload, "value") ||
    payload.value === undefined) {
    throw new Error(`Invalid SQL root key payload for "${key}"`);
  }
  return { revision: payload.revision as number, value: payload.value };
}

function isKeyList(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) && value.every((key) => typeof key === "string" && !!key));
}

/** Browser client for the standalone Node server's native SQLite database. */
export class NodeSqliteStorage implements SqlBootstrapStorage {
  readonly backendKind = "server-sql" as const;
  private enabled = false;
  private revision = 0;
  private bootstrapPayload: SqlBootstrapPayload | null = null;
  /**
   * Root keys this client has already loaded on demand during this session.
   *
   * The bootstrap payload is refetched whenever a commit invalidates it, and the
   * server will keep reporting the same keys as withheld. The live `Database`
   * outlives those refetches, so re-marking an already-hydrated key as deferred
   * would make the compatibility audit ignore the user's later edits to it --
   * silent non-persistence, the same failure class in a different shape.
   */
  private readonly residentRootKeys = new Set<string>();

  constructor(
    private readonly request: AuthenticatedRequest,
    /** Root keys to ask the server to withhold. Empty by default -- see the constant. */
    private readonly deferRootKeys: readonly string[] = DEFERRED_BOOTSTRAP_ROOT_KEYS,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  getRevision(): number {
    return this.revision;
  }

  private async fetchDump(): Promise<ServerDump> {
    const response = await this.request("/api/sql/snapshot");
    if (!response.ok) throw new Error(`SQL snapshot failed (${response.status})`);
    const dump = (await response.json()) as ServerDump;
    this.revision = Number(dump.revision) || 0;
    return dump;
  }

  private validateBootstrap(payload: unknown): SqlBootstrapPayload {
    if (!payload || typeof payload !== "object") throw new Error("Invalid SQL bootstrap payload");
    const value = payload as Partial<SqlBootstrapPayload>;
    if ((value.status !== "ready" && value.status !== "empty") ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings) ||
      !Array.isArray(value.botPresets) || !Array.isArray(value.characters) ||
      (value.selectedCharacterId !== null && typeof value.selectedCharacterId !== "string") ||
      (value.selectedChatId !== null && typeof value.selectedChatId !== "string")) {
      throw new Error("Invalid SQL bootstrap payload");
    }
    // A malformed defer report is not something to shrug off: it decides which
    // keys are protected from deletion, so a bad one must fail the bootstrap
    // rather than silently degrade to "nothing was deferred".
    if (!isKeyList(value.deferredRootKeys) ||
      !isKeyList(value.absentDeferredRootKeys) ||
      !isKeyList(value.unreadableRootKeys)) {
      throw new Error("Invalid SQL bootstrap deferred root key report");
    }
    // `pluginCustomStorage` may be withheld, but ONLY when the payload says so.
    // A silently missing map would otherwise reach the client as "the user has
    // no plugin storage", which is the exact reading this whole mechanism
    // exists to prevent.
    const pluginStorageWithheld = (value.deferredRootKeys ?? []).includes("pluginCustomStorage");
    if (pluginStorageWithheld) {
      if (value.pluginCustomStorage !== undefined) {
        // Contradictory, but not fatal: `rebuildBootstrap` drops the value and
        // keeps the key deferred, and logs that it did.
        if (typeof value.pluginCustomStorage !== "object" || Array.isArray(value.pluginCustomStorage)) {
          throw new Error("Invalid SQL bootstrap payload");
        }
      }
    } else if (!value.pluginCustomStorage ||
      typeof value.pluginCustomStorage !== "object" ||
      Array.isArray(value.pluginCustomStorage)) {
      throw new Error("Invalid SQL bootstrap payload");
    }
    return value as SqlBootstrapPayload;
  }

  private acceptReadRevision(revision: number): void {
    if (this.bootstrapPayload && this.bootstrapPayload.revision !== revision) {
      this.bootstrapPayload = null;
    }
    this.revision = revision;
  }

  async loadBootstrap(): Promise<SqlBootstrapPayload> {
    markPerformance("bootstrap-fetch:start");
    let response: Response;
    try {
      // A key already loaded on demand stops being worth deferring: the point
      // of deferral is to skip work at startup, and the startup is over. Asking
      // for it again would only make every later refetch rebuild a database
      // that is missing a map this client already has.
      response = await this.request(bootstrapRequestPath(
        this.deferRootKeys.filter((key) => !this.residentRootKeys.has(key)),
      ));
    } finally {
      markPerformance("bootstrap-fetch:end");
      measurePerformance("bootstrap-fetch", "bootstrap-fetch:start", "bootstrap-fetch:end");
    }
    if (!response.ok) throw new SqlHttpError(`SQL bootstrap failed (${response.status})`, response.status);
    const payload = this.validateBootstrap(await response.json());
    markPerformance("bootstrap-json:end");
    measurePerformance("bootstrap-json", "bootstrap-fetch:end", "bootstrap-json:end");
    this.revision = payload.revision;
    this.bootstrapPayload = payload;
    this.enabled = true;
    return payload;
  }

  async init(): Promise<boolean> {
    if (this.enabled) return true;
    await this.loadBootstrap();
    this.enabled = true;
    return true;
  }

  /**
   * Reconciles the deferral registry with what this bootstrap actually shipped,
   * and returns the honoured defer set.
   *
   * Keys the payload sent are resident, so any stale deferred mark on them is
   * cleared. Keys the payload withheld are marked deferred, which makes them
   * undeletable and invisible to the compatibility audit's root diff until
   * `ensureRootKeyHydrated` installs the real value.
   *
   * `resetDeferredRootKeys()` is deliberately not used here: it would also wipe
   * the refusal log, which is the evidence trail for upstream diff bugs.
   */
  private syncDeferredRootKeys(payload: SqlBootstrapPayload): Set<string> {
    const deferred = new Set<string>();
    // Unreadable keys are registered in storage but rebuilt to no value. Since
    // `undefined` does not survive JSON, they reach us looking exactly like keys
    // that were never stored -- and a dirty mark on one would become a DELETE of
    // a row that still exists. They exist, so they are deferred: undeletable,
    // and loadable on demand (that load will fail loudly, which is the truth).
    const unreadable = (payload.unreadableRootKeys ?? []).filter((key) => !!key);
    if (unreadable.length) {
      console.error(
        "[SQL deferred bootstrap] the server could not rebuild values for root keys that are " +
        `registered in storage: ${unreadable.join(", ")}. Treating them as deferred so nothing ` +
        "mistakes them for deleted keys. Their values are unknown, not empty.",
      );
    }
    for (const key of [...(payload.deferredRootKeys ?? []), ...unreadable]) {
      if (!key) continue;
      // Already loaded once this session: the live database holds the real
      // value, so it is resident no matter what a later payload withholds.
      if (this.residentRootKeys.has(key)) continue;
      if (STRUCTURAL_BOOTSTRAP_KEYS.has(key)) {
        console.error(
          `[SQL deferred bootstrap] server reported "${key}" as deferred, but the client ` +
          "always rebuilds that key from a dedicated payload field. Ignoring the deferral; " +
          "the key is resident.",
        );
        continue;
      }
      deferred.add(key);
    }
    for (const key of deferredRootKeySnapshot()) {
      // A key we fetched is the installer's to clear, not ours: it may have
      // been fetched but not yet written into the database.
      if (deferred.has(key) || this.residentRootKeys.has(key)) continue;
      clearDeferredRootKey(key);
    }
    markRootKeysDeferred(deferred);
    return deferred;
  }

  /**
   * `pluginCustomStorage` is the one dedicated bootstrap field the server is
   * allowed to withhold, so it is the one field whose absence has to be read
   * carefully.
   *
   * Withheld and deferred -> the property is left OFF the object entirely. Not
   * `{}`, not an own `undefined`: every read site distinguishes "the property
   * is missing" from "the map is empty", and only the second is a fact about
   * the user's data.
   *
   * Withheld while already resident this session is the odd case. The live
   * `Database` holds the real map, but this rebuild is a different object and
   * genuinely has nothing to put in it, so the property stays off and the
   * mismatch is reported rather than papered over with an empty map.
   */
  private installPluginCustomStorage(
    database: Database,
    payload: SqlBootstrapPayload,
    deferred: ReadonlySet<string>,
  ): void {
    const shipped = payload.pluginCustomStorage;
    if (deferred.has("pluginCustomStorage")) {
      if (shipped !== undefined) {
        console.error(
          '[SQL deferred bootstrap] "pluginCustomStorage" was reported deferred but a value for ' +
          "it was also sent. Omitting that value and keeping the key deferred; it will be " +
          "loaded on demand.",
        );
      }
      return;
    }
    if (shipped !== undefined) {
      database.pluginCustomStorage = shipped as Database["pluginCustomStorage"];
      // Resident by a route other than an on-demand load. Record it, or a later
      // bootstrap that withholds the key would mark it deferred while the live
      // value is right here — and a stuck deferral silently drops every write.
      this.residentRootKeys.add("pluginCustomStorage");
      return;
    }
    console.error(
      '[SQL deferred bootstrap] the bootstrap payload withheld "pluginCustomStorage" without ' +
      "deferring it (it was already loaded on demand earlier in this session). This rebuilt " +
      "database is left without the property rather than being given an empty map; its value " +
      "is unknown here, not empty.",
    );
  }

  private rebuildBootstrap(payload: SqlBootstrapPayload): Database | null {
    const deferred = this.syncDeferredRootKeys(payload);
    if (payload.status !== "ready") return null;
    const settings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload.settings)) {
      if (!deferred.has(key)) {
        settings[key] = value;
        continue;
      }
      // The payload contradicted itself. Trust the deferral, not the value:
      // a withheld key's stand-in is exactly the "user has no plugins" reading
      // that this whole mechanism exists to prevent. Drop it and load on demand.
      console.error(
        `[SQL deferred bootstrap] "${key}" was reported deferred but a value for it was also ` +
        "sent. Omitting that value and keeping the key deferred; it will be loaded on demand.",
      );
    }
    const database = {
      ...settings,
      botPresets: payload.botPresets,
      characters: payload.characters.map((character) => ({
        ...character,
        detailsLoaded: false,
        chats: (character.chats ?? []).map((chat) => ({
          ...chat,
          message: [],
          messagesLoaded: false,
          messagesFullyLoaded: false,
        })),
      })),
    } as unknown as Database;
    this.installPluginCustomStorage(database, payload, deferred);
    database.botPresetsId = Math.max(0, database.botPresets.findIndex(
      (preset) => preset.id === (payload.settings as { activeBotPresetId?: unknown }).activeBotPresetId,
    ));
    delete (database as unknown as Record<string, unknown>).activeBotPresetId;
    (database as Database & { selectedCharacterId?: string | null }).selectedCharacterId = payload.selectedCharacterId;
    (database as Database & { selectedChatId?: string | null }).selectedChatId = payload.selectedChatId;
    return database;
  }

  /**
   * Reports whether this SQL database is a migration that never finished, and
   * says so loudly when it is.
   *
   * `system_storage_meta.initialized` is set by the server on every successful
   * commit, so after the first slice of a chunked migration it already says
   * "canonical" about a database holding a fraction of the user's data. The
   * marker is the second fact that makes the first one readable, and it is
   * absent on every database that migrated in one request or finished
   * migrating in several.
   *
   * `marker === undefined` means the key is not there, which is the only
   * reading that means "no migration is in flight".
   */
  private migrationIsIncomplete(marker: unknown): boolean {
    if (marker === undefined) return false;
    console.error(
      "[SQL migration] this SQL database is marked as a migration in progress " +
      `(${SQL_MIGRATION_MARKER_KEY} = ${JSON.stringify(marker)}), so it holds only part of the ` +
      "legacy database. Refusing to treat it as ready: the legacy save file stays canonical and " +
      "the migration runs again from a clean slate.",
    );
    // Anything this half-written database reported as withheld describes a
    // database that is about to be replaced wholesale. A mark left set here
    // would make `buildSqlReplaceCommit` refuse the very migration that
    // repairs it, and the user would be stuck in legacy mode permanently.
    for (const key of deferredRootKeySnapshot()) clearDeferredRootKey(key);
    return true;
  }

  async loadRecoverySnapshot(): Promise<SqlLoadDatabaseResult | null> {
    const dump = await this.fetchDump();
    this.bootstrapPayload = null;
    const markerRow = (dump.tables.system_settings ?? []).find(
      (row) => row.key === SQL_MIGRATION_MARKER_KEY,
    );
    // The recovery path has to reach the same verdict as the normal one, or a
    // degraded startup would adopt the half-migrated database that
    // `loadDatabase` just refused.
    if (dump.status === "ready" && this.migrationIsIncomplete(
      markerRow ? (markerRow.text_value ?? true) : undefined,
    )) {
      return { status: "empty", revision: dump.revision, database: null };
    }
    const database = this.rebuild(dump);
    return { status: database ? "ready" : "empty", revision: dump.revision, database };
  }

  private nodes(
    dump: ServerDump,
    table: string,
    predicate: (row: Record<string, unknown>) => boolean,
  ): unknown {
    const rows = (dump.tables[table] ?? []).filter(predicate);
    return rows.length ? rebuildRelationalValue(rows) : undefined;
  }

  private setting(dump: ServerDump, key: string): unknown {
    return this.nodes(
      dump,
      "setting_extension_nodes",
      (row) => row.setting_key === key,
    );
  }

  private message(dump: ServerDump, chatId: string, messageId: string): Message {
    const message = (this.nodes(
      dump,
      "message_extension_nodes",
      (row) => row.chat_id === chatId && row.message_id === messageId,
    ) ?? {}) as Message;
    message.chatId = messageId;
    return message;
  }

  private rebuild(dump: ServerDump): Database | null {
    // A full dump is complete knowledge of every root key, so nothing is
    // "known to exist but not loaded" any more. Record them as resident too:
    // a later bootstrap that withholds one must not be able to re-defer a key
    // whose real value is already in the live database.
    for (const key of deferredRootKeySnapshot()) {
      clearDeferredRootKey(key);
      this.residentRootKeys.add(key);
    }
    if (dump.status !== "ready") return null;
    const database = {} as Database;
    for (const row of dump.tables.system_settings ?? []) {
      const key = row.key as string;
      (database as any)[key] = this.setting(dump, key);
    }

    database.pluginCustomStorage = {};
    for (const row of dump.tables.plugin_custom_storage ?? []) {
      try {
        database.pluginCustomStorage[row.key as string] = JSON.parse(
          row.value as string,
        );
      } catch {
        database.pluginCustomStorage[row.key as string] = row.value;
      }
    }

    database.characters = sorted(dump.tables.characters ?? []).map((row) => {
      const value = (this.nodes(
        dump,
        "character_extension_nodes",
        (node) => node.character_id === row.id,
      ) ?? {}) as character;
      value.chaId = row.id as string;
      const chatRows = sorted(
        (dump.tables.chats ?? []).filter(
          (chat) => chat.character_id === row.id,
        ),
      );
      value.chats = chatRows.map((chatRow) => {
        const chatId = chatRow.id as string;
        const chat = (this.nodes(
          dump,
          "chat_extension_nodes",
          (node) => node.chat_id === chatId,
        ) ?? {}) as Chat;
        chat.id = chatId;
        const messageRows = sorted(
          (dump.tables.messages ?? []).filter(
            (messageRow) => messageRow.chat_id === chatId,
          ),
        );
        chat.message = messageRows.map((messageRow) =>
          this.message(dump, chatId, messageRow.id as string),
        );
        return chat;
      });
      return value;
    });

    const presetRows = sorted(dump.tables.bot_presets ?? []);
    database.botPresets = presetRows.map((row) => {
      const preset = JSON.parse(String(row.data || "{}")) as StoredBotPreset;
      preset.id = row.preset_id as string;
      return preset;
    });
    const activePresetId = (database as any).activeBotPresetId as string | undefined;
    database.botPresetsId = Math.max(
      0,
      database.botPresets.findIndex((preset) => preset.id === activePresetId),
    );
    delete (database as any).activeBotPresetId;
    return database;
  }

  async loadDatabase(_options?: SqlLoadDatabaseOptions): Promise<SqlLoadDatabaseResult | null> {
    if (!this.enabled) await this.init();
    const payload = this.bootstrapPayload ?? await this.loadBootstrap();
    const incomplete = payload.status === "ready" && this.migrationIsIncomplete(
      (payload.settings as Record<string, unknown>)[SQL_MIGRATION_MARKER_KEY],
    );
    // The server knows how far the abandoned run got and says so in the payload.
    // Reporting "empty" without that is how a database stuck eleven chunks in
    // becomes indistinguishable from one that was never migrated -- which is
    // exactly the shape of failure that let this whole defect hide for months.
    const session = (payload as {
      migration?: {
        chunksApplied?: number
        totalChunks?: number | null
        startedAt?: string | null
        archivedPath?: string | null
      } | null
    }).migration;
    if (incomplete || session) {
      console.error(
        "[SQL migration] the SQL database is incomplete and will be rebuilt from the legacy source" +
        (session
          ? `: an earlier attempt stopped after ${session.chunksApplied ?? "?"} of ` +
            `${session.totalChunks ?? "?"} chunks, started ${session.startedAt ?? "unknown"}` +
            (session.archivedPath ? `, prior database archived at ${session.archivedPath}` : "")
          : ": a migration marker was left behind by an interrupted attempt."),
      );
    }
    if (incomplete) {
      // "Not complete" is reported as "not present", never as "ready": the
      // caller migrates again from the legacy source, which is intact.
      return { status: "empty", revision: payload.revision, database: null };
    }
    const database = this.rebuildBootstrap(payload);
    return { status: payload.status, revision: payload.revision, database };
  }

  async loadCharacterHydration(characterId: string): Promise<character | null> {
    const metric = runtimeMetrics.start("character-hydration");
    try {
    const response = await this.request(`/api/sql/characters/${encodeURIComponent(characterId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SQL character load failed (${response.status})`);
    const payload = await response.json() as { revision: number; character: character };
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !payload.character || typeof payload.character !== "object") {
      throw new Error("Invalid SQL character payload");
    }
    this.acceptReadRevision(payload.revision);
    return payload.character;
    } finally {
      runtimeMetrics.end(metric);
    }
  }

  /**
   * Fetches one deferred root key's real value.
   *
   * Every failure path rejects. Nothing here returns a fallback, and nothing
   * here clears the deferred mark -- that is the caller's job, and only after
   * the value is actually resident in the database.
   */
  async loadRootKeyHydration(key: string): Promise<unknown> {
    if (!key) throw new Error("SQL root key load requires a non-empty key");
    const response = await this.request(rootKeyRequestPath(key));
    const { revision, value } = await readRootKeyResponse(key, response);
    this.acceptReadRevision(revision);
    // Only reached when the value is trustworthy; a rejection above leaves the
    // key deferred and still eligible to be re-marked by a later bootstrap.
    this.residentRootKeys.add(key);
    // The cached payload was built from a request that asked for this key to be
    // withheld, so it no longer describes what this client can serve. Dropping
    // it makes the next rebuild refetch without the deferral and come back
    // complete, instead of reproducing a projection that is missing the key.
    this.bootstrapPayload = null;
    return value;
  }

  async loadChatMessageReversePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlReverseMessagePage> {
    const metric = runtimeMetrics.start("message-page");
    try {
    const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Math.floor(limit)))) });
    if (before !== undefined) params.set("before", String(before));
    const response = await this.request(`/api/sql/chats/${encodeURIComponent(chatId)}/messages?${params}`);
    if (!response.ok) throw new Error(`SQL message page failed (${response.status})`);
    const page = await response.json() as SqlReverseMessagePage;
    if (!Number.isSafeInteger(page.revision) || page.revision < 0 ||
      page.chatId !== chatId || !Array.isArray(page.messages) ||
      !Array.isArray(page.positions) || page.positions.length !== page.messages.length ||
      !page.positions.every((position) => Number.isSafeInteger(position) && position >= 0) ||
      !Number.isSafeInteger(page.nextPosition) || page.nextPosition < 0 ||
      !Number.isSafeInteger(page.total) || page.total < 0 ||
      typeof page.hasMore !== "boolean") {
      throw new Error("Invalid SQL message page payload");
    }
    this.acceptReadRevision(page.revision);
    return page;
    } finally {
      runtimeMetrics.end(metric);
    }
  }

  private async listAncillaryKeys(
    path: "/api/sql/chat-drafts" | "/api/sql/cold-storage",
    property: "keys" | "items",
  ): Promise<string[]> {
    const values: string[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    while (true) {
      const params = new URLSearchParams({ limit: "100" });
      if (after !== undefined) params.set("after", after);
      const response = await this.request(`${path}?${params}`);
      if (!response.ok) throw new Error(`SQL ancillary list failed (${response.status})`);
      const payload = await response.json() as Record<string, unknown>;
      const page = payload?.[property];
      const hasMore = payload?.hasMore;
      const nextAfter = payload?.nextAfter;
      if (!Array.isArray(page) || page.length > 100 || page.some((item) => typeof item !== "string") ||
        typeof hasMore !== "boolean" ||
        (nextAfter !== null && typeof nextAfter !== "string")) {
        throw new Error("Invalid SQL ancillary page");
      }
      values.push(...page as string[]);
      if (!hasMore) {
        if (nextAfter !== null) throw new Error("Invalid SQL ancillary cursor");
        return values;
      }
      if (typeof nextAfter !== "string" || !nextAfter || nextAfter === after ||
        seenCursors.has(nextAfter) || page.length === 0 || page.at(-1) !== nextAfter) {
        throw new Error("SQL ancillary cursor did not progress");
      }
      seenCursors.add(nextAfter);
      after = nextAfter;
    }
  }

  /*
   * -------------------------------------------------------------------------
   * COMMIT TRANSPORT -- the only place that decides how many requests a commit
   * becomes, and the only place that encodes the chunk wire format.
   *
   *   POST /api/sql/commit
   *       { baseRevision, action, statements }              (every commit)
   *       { baseRevision, action, statements, migration }   (migration slices)
   *
   * `migration` is additive: the server in this repository reads only
   * `baseRevision`, `action` and `statements`, so a chunked migration works
   * against it unchanged, one ordinary commit at a time. If the server grows a
   * resumable migration protocol, `sendStatements` and `sendMigration` below
   * are the whole surface to adjust.
   * -------------------------------------------------------------------------
   */

  private async sendStatements(
    statements: Statement[],
    action: string,
    baseRevision = this.revision,
    migration?: SqlMigrationChunkMeta,
  ): Promise<SqlCommitResult> {
    const response = await this.request("/api/sql/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        migration
          ? { baseRevision, action, statements, migration }
          : { baseRevision, action, statements },
      ),
    });
    if (response.status === 409) {
      const body = await response.json() as {
        code?: unknown;
        error?: unknown;
        currentRevision?: unknown;
      };
      this.bootstrapPayload = null;
      const code = typeof body?.code === "string" ? body.code : "";
      if (code && code !== "SQL_REVISION_CONFLICT") {
        // Not a stale revision. Leaving `this.revision` alone matters: these
        // bodies carry no `currentRevision`, and coercing a missing one to 0
        // would leave the client committing against revision 0 forever.
        throw new SqlCommitConflictError(
          code,
          typeof body?.error === "string" && body.error
            ? `SQL commit rejected (${code}): ${body.error}`
            : `SQL commit rejected (${code})`,
          body,
        );
      }
      this.revision = Number(body.currentRevision) || 0;
      throw new SqlRevisionConflictError(this.revision);
    }
    if (!response.ok) {
      // The status alone was the whole error for years, so "SQL commit is too
      // large" -- the one sentence that explained a four-minute failed
      // migration -- never left the server.
      throw new SqlHttpError(
        `SQL commit failed (${response.status})${await serverErrorDetail(response)}`,
        response.status,
      );
    }
    const result = (await response.json()) as SqlCommitResult;
    this.revision = result.revision;
    this.bootstrapPayload = null;
    return result;
  }

  private async buildCommitStatements(
    commit: SqlCommit,
  ): Promise<{ prelude: Statement[]; body: Statement[] }> {
    const prelude: Statement[] = [];
    if (commit.replaceAll) {
      prelude.push(
        { sql: "DELETE FROM system_settings", bind: [] },
        { sql: "DELETE FROM plugin_custom_storage", bind: [] },
        { sql: "DELETE FROM characters", bind: [] },
        { sql: "DELETE FROM bot_presets", bind: [] },
      );
    }
    const body: Statement[] = [];
    await applySqliteCommit(commit, (sql, bind = []) => {
      body.push({ sql, bind });
    });
    return { prelude, body };
  }

  /**
   * Sends a replace-all migration, splitting it across requests when it is too
   * large for one.
   *
   * Splitting costs the migration its single transaction, so it buys that back
   * with the in-progress marker: raised in the same request as the opening
   * DELETEs (never before them -- `DELETE FROM system_settings` would wipe it)
   * and cleared in the same request as the last slice. There is therefore no
   * instant at which the database is incomplete and unmarked, and no instant at
   * which it is complete and still marked.
   *
   * A migration that fits in one request is still one request and one
   * transaction. It does carry a chunk descriptor, because that is the only
   * thing that can clear a session left behind by an interrupted migration.
   */
  private async sendMigration(
    prelude: Statement[],
    body: Statement[],
    action: string,
    baseRevision: number,
  ): Promise<SqlCommitResult> {
    const total = prelude.length + body.length;
    const id = uuidv4();
    const statements = total <= SQL_MIGRATION_CHUNK_STATEMENTS
      ? [...prelude, ...body]
      : [
        ...prelude,
        ...await migrationMarkerStatements(`${id} started ${new Date().toISOString()}`),
        ...body,
        ...await migrationMarkerStatements(null),
      ];
    const chunkCount = Math.max(1, Math.ceil(statements.length / SQL_MIGRATION_CHUNK_STATEMENTS));

    let revision = baseRevision;
    let result: SqlCommitResult = { revision: baseRevision };
    for (let index = 0; index < chunkCount; index++) {
      const start = index * SQL_MIGRATION_CHUNK_STATEMENTS;
      const final = index === chunkCount - 1;
      reportSqlMigrationProgress({
        phase: "uploading",
        chunk: index + 1,
        chunkCount,
        statementsSent: start,
        statementTotal: statements.length,
      });
      try {
        result = await this.sendStatements(
          statements.slice(start, start + SQL_MIGRATION_CHUNK_STATEMENTS),
          // The last slice carries the caller's action, so a server that keys
          // off "replace-all" still sees it, and sees it last.
          final ? action : `${action}-chunk-${index + 1}-of-${chunkCount}`,
          revision,
          // Always sent, single-chunk migrations included. Only a chunk 0 can
          // supersede a session abandoned by an earlier interrupted migration;
          // without one, a retry small enough to fit in a single request is
          // refused with SQL_MIGRATION_IN_PROGRESS forever, and the user can
          // never get out of legacy mode. A lone chunk is chunk 0 and final, so
          // it opens and closes the session in the same transaction.
          { id, chunk: index, totalChunks: chunkCount, final },
        );
      } catch (error) {
        // A conflict keeps its type: callers retry on it, and it means another
        // writer moved the revision, not that this migration is broken.
        if (chunkCount === 1 || error instanceof SqlRevisionConflictError) throw error;
        throw new SqlMigrationChunkError(index + 1, chunkCount, error);
      }
      // Every slice is committed against the revision the previous one
      // returned; the server bumps it on each success.
      revision = result.revision;
    }
    return result;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    const action = commit.action || (commit.replaceAll ? "replace-all" : "sync");
    const { prelude, body } = await this.buildCommitStatements(commit);
    // Ordinary commits stay one request and one server transaction, whatever
    // their size. Their all-or-nothing behaviour is what keeps a half-saved
    // chat from existing, and only a replace-all has the marker that makes a
    // partial write recognisable afterwards.
    if (!commit.replaceAll) {
      return await this.sendStatements([...prelude, ...body], action, commit.baseRevision);
    }
    return await this.sendMigration(prelude, body, action, commit.baseRevision);
  }

  async replaceDatabase(database: Database): Promise<boolean> {
    // Flattening the legacy database into statements happens before any
    // request and takes seconds on a large one, so it is announced: it is the
    // stretch that looks most like a hang.
    reportSqlMigrationProgress({
      phase: "preparing",
      chunk: 0,
      chunkCount: 0,
      statementsSent: 0,
      statementTotal: 0,
    });
    await this.commit(buildSqlReplaceCommit(database, this.revision));
    return true;
  }

  private async current(): Promise<Database> {
    return (await this.loadDatabase({ shallow: true }))?.database ?? ({} as Database);
  }

  async loadCharacter(characterId: string): Promise<character | null> {
    return await this.loadCharacterHydration(characterId);
  }

  async loadChat(chatId: string, options?: { messageLimit?: number }): Promise<Chat | null> {
    for (const character of (await this.current()).characters ?? []) {
      const chat = character.chats?.find((item) => item.id === chatId);
      if (chat) {
        if (options?.messageLimit) {
          const page = await this.loadChatMessageReversePage(chatId, undefined, options.messageLimit);
          return { ...chat, message: page.messages };
        }
        return chat;
      }
    }
    return null;
  }

  async loadChatMessages(chatId: string): Promise<Message[]> {
    return (await this.loadChatMessageReversePage(chatId, undefined, 100)).messages;
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage> {
    const page = await this.loadChatMessageReversePage(chatId, before, limit);
    return {
      messages: page.messages,
      offset: page.nextBefore ?? 0,
      total: page.total,
      hasMore: page.hasMore,
    };
  }

  async loadPersonas(): Promise<RisuPersona[]> {
    return (await this.current()).personas ?? [];
  }

  async listBotPresets(): Promise<BotPresetSummary[]> {
    return ((await this.current()).botPresets ?? []).map((preset, position) => ({
      id: preset.id!,
      position,
      name: preset.name ?? "",
      image: preset.image ?? "",
      apiType: preset.apiType ?? "",
      aiModel: preset.aiModel ?? "",
      hash: "",
    }));
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    const preset = ((await this.current()).botPresets ?? []).find(
      (item) => item.id === id,
    );
    return preset ? preset as StoredBotPreset : null;
  }

  async loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]> {
    return (await this.current()).loreBook ?? [];
  }

  async loadModules(): Promise<RisuModule[]> {
    return (await this.current()).modules ?? [];
  }

  async loadPrompts(): Promise<Record<string, unknown>> {
    return ((await this.current()) as any).prompts ?? {};
  }

  async loadScripts(): Promise<customscript[]> {
    return (await this.current()).globalscript ?? [];
  }

  async loadPlugins(): Promise<unknown[] | null> {
    return (await this.current()).plugins ?? null;
  }

  async loadPluginCustomStorage(): Promise<Record<string, unknown> | null> {
    return (await this.current()).pluginCustomStorage ?? null;
  }

  async listPluginCustomStorageKeys(): Promise<string[]> {
    return Object.keys((await this.current()).pluginCustomStorage ?? {});
  }

  async loadPluginCustomStorageKey(key: string): Promise<unknown> {
    return (await this.current()).pluginCustomStorage?.[key];
  }

  async loadSettingKey(key: string): Promise<unknown> {
    return (await this.current() as any)[key];
  }

  async getChatDraft(key: string): Promise<{ m: string; t: string } | null> {
    const response = await this.request(`/api/sql/chat-drafts/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SQL chat draft load failed (${response.status})`);
    const payload = await response.json() as { draft?: { m?: unknown; t?: unknown } };
    if (!payload.draft || typeof payload.draft.m !== "string" || typeof payload.draft.t !== "string") {
      throw new Error("Invalid SQL chat draft payload");
    }
    return { m: payload.draft.m, t: payload.draft.t };
  }

  async listChatDraftKeys(): Promise<string[]> {
    return await this.listAncillaryKeys("/api/sql/chat-drafts", "keys");
  }

  async setChatDraft(key: string, draft: { m: string; t: string }): Promise<void> {
    await this.sendStatements([{
      sql: `INSERT INTO chat_drafts (draft_key, message_text, translate_text, updated_at)
            VALUES (?, ?, ?, datetime('now')) ON CONFLICT(draft_key) DO UPDATE SET
            message_text=excluded.message_text, translate_text=excluded.translate_text,
            updated_at=datetime('now')`,
      bind: [key, draft.m, draft.t],
    }], "chat-draft");
  }

  async removeChatDrafts(keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    await this.sendStatements([{
      sql: `DELETE FROM chat_drafts WHERE draft_key IN (${keys.map(() => "?").join(",")})`,
      bind: keys,
    }], "chat-draft-delete");
    return keys.length;
  }

  async getColdStorageItem(key: string): Promise<unknown | null> {
    const response = await this.request(`/api/sql/cold-storage/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SQL cold storage load failed (${response.status})`);
    const payload = await response.json() as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, "item")) {
      throw new Error("Invalid SQL cold storage payload");
    }
    return payload.item;
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    return { items: await this.listAncillaryKeys("/api/sql/cold-storage", "items") };
  }

  async setColdStorageItem(key: string, value: unknown): Promise<boolean> {
    const statements: Statement[] = [];
    await writeSqliteColdStorage((sql, bind = []) => {
      statements.push({ sql, bind });
    }, key, value);
    await this.sendStatements(statements, "cold-storage");
    return true;
  }

  async removeColdStorageItems(keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    await this.sendStatements([{
      sql: `DELETE FROM cold_archives WHERE archive_id IN (${keys.map(() => "?").join(",")})`,
      bind: keys,
    }], "cold-storage-delete");
    return keys.length;
  }

  async pruneColdStorage(retainedKeys: string[]): Promise<number> {
    const current = (await this.listColdStorageItems()).items;
    return await this.removeColdStorageItems(current.filter((key) => !retainedKeys.includes(key)));
  }

  async listRevisions(limit = 100): Promise<SqlRevision[]> {
    const params = new URLSearchParams({ limit: String(boundedLimit(limit, 100, 100)) });
    const response = await this.request(`/api/sql/revisions?${params}`);
    if (!response.ok) throw new Error(`SQL revision list failed (${response.status})`);
    const payload = await response.json() as { revisions?: unknown };
    if (!Array.isArray(payload.revisions) || payload.revisions.some((revision) =>
      !revision || typeof revision !== "object" ||
      !Number.isSafeInteger((revision as { id?: unknown }).id) ||
      typeof (revision as { action?: unknown }).action !== "string")) {
      throw new Error("Invalid SQL revision payload");
    }
    return payload.revisions as SqlRevision[];
  }

  async restoreRevision(revisionId: number) {
    return { revision: this.revision, revisionId };
  }

  async searchMessages(query: string, _scope = "all", limit = 50): Promise<SqlMessageSearchResult[]> {
    const params = new URLSearchParams({
      query,
      limit: String(boundedLimit(limit, 50, 50)),
    });
    const response = await this.request(`/api/sql/search/messages?${params}`);
    if (!response.ok) throw new Error(`SQL message search failed (${response.status})`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("Invalid SQL message search payload");
    return payload.results as SqlMessageSearchResult[];
  }

  async getTokenUsage(): Promise<SqlTokenUsage[]> {
    return [];
  }

  async getBotChatStats(): Promise<SqlBotChatStats[]> {
    return [];
  }

  async searchCharactersByTag(tag: string, limit = 100): Promise<SqlCharacterSearchResult[]> {
    return await this.searchCharacters("tag", tag, limit);
  }

  async searchCharactersByName(name: string, limit = 100): Promise<SqlCharacterSearchResult[]> {
    return await this.searchCharacters("name", name, limit);
  }

  private async searchCharacters(
    mode: "name" | "tag",
    query: string,
    limit: number,
  ): Promise<SqlCharacterSearchResult[]> {
    const params = new URLSearchParams({
      mode,
      query,
      limit: String(boundedLimit(limit, 100, 100)),
    });
    const response = await this.request(`/api/sql/search/characters?${params}`);
    if (!response.ok) throw new Error(`SQL character search failed (${response.status})`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("Invalid SQL character search payload");
    return payload.results as SqlCharacterSearchResult[];
  }
}
