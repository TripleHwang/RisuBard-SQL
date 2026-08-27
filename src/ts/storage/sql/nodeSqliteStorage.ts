import type {
  BotPresetSummary,
  SqlBotChatStats,
  SqlBootstrapPayload,
  SqlDeferredBootstrapPayload,
  SqlBootstrapStorage,
  SqlChatHydration,
  SqlCharacterRepairBackupCensus,
  SqlCharacterRepairResult,
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
  SqlRevisionConflictError,
  type SqlCommit,
  type SqlCommitResult,
} from "./sqlCommit";
import {
  armDeferredRootWriteGate,
  DEFERRED_ROOT_KEYS,
  isDeferredRootHydrationReady,
  markDeferredRootHydrationApplied,
} from "./rootWritePolicy";

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

/**
 * Validates the `backups` census on a repair response. Anything malformed is
 * dropped entirely rather than partially trusted: the census exists so the UI
 * can say "N of M backups were checked", and a half-parsed census would let it
 * quote a number that was never measured. With the census absent the caller
 * falls back to the reason code alone, which is always safe.
 */
function parseRepairBackupCensus(raw: unknown): SqlCharacterRepairBackupCensus | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const counts: number[] = [];
  for (const key of ["total", "examined", "unreadable", "skipped"] as const) {
    const value = Number(source[key]);
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    counts.push(value);
  }
  const [total, examined, unreadable, skipped] = counts;
  // The server guarantees this identity; if it does not hold, the payload is
  // not one we can quote numbers from.
  if (examined + unreadable + skipped !== total) return undefined;
  return { total, examined, unreadable, skipped };
}

export class SqlHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SqlHttpError";
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(maximum, Math.max(1, normalized));
}

function sorted(rows: Record<string, unknown>[], key = "position") {
  return [...rows].sort((left, right) => Number(left[key]) - Number(right[key]));
}

/** Browser client for the standalone Node server's native SQLite database. */
export class NodeSqliteStorage implements SqlBootstrapStorage {
  readonly backendKind = "server-sql" as const;
  private enabled = false;
  private revision = 0;
  private bootstrapPayload: SqlBootstrapPayload | null = null;
  private deferredBootstrapPayload: SqlDeferredBootstrapPayload | null = null;

  constructor(private readonly request: AuthenticatedRequest) {
    // This backend is the only one that withholds root keys from its first
    // payload, so its mere existence is what arms the write gate. Arming here
    // (rather than from bootstrap.ts) is the point: no ordering of startup
    // calls can leave deferred keys writable while they are still unloaded.
    armDeferredRootWriteGate();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** True once deferred root keys are safe to upsert or delete. */
  isDeferredHydrationReady(): boolean {
    return isDeferredRootHydrationReady();
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
      (value.migrationState !== undefined && !["empty", "migrating", "ready", "failed"].includes(value.migrationState)) ||
      !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings) ||
      (value.pluginCustomStorage !== undefined && (typeof value.pluginCustomStorage !== "object" || Array.isArray(value.pluginCustomStorage))) ||
      (value.botPresets !== undefined && !Array.isArray(value.botPresets)) || !Array.isArray(value.characters) ||
      (value.selectedCharacterId !== null && typeof value.selectedCharacterId !== "string") ||
      (value.selectedChatId !== null && typeof value.selectedChatId !== "string")) {
      throw new Error("Invalid SQL bootstrap payload");
    }
    return value as SqlBootstrapPayload;
  }

  private validateDeferredBootstrap(payload: unknown): SqlDeferredBootstrapPayload {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid SQL deferred bootstrap payload');
    const value = payload as Partial<SqlDeferredBootstrapPayload>;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings) || !value.pluginCustomStorage || typeof value.pluginCustomStorage !== 'object' || Array.isArray(value.pluginCustomStorage) || !Array.isArray(value.botPresets)) throw new Error('Invalid SQL deferred bootstrap payload');
    return value as SqlDeferredBootstrapPayload;
  }

  private acceptReadRevision(revision: number): void {
    if (this.bootstrapPayload && this.bootstrapPayload.revision !== revision) {
      this.bootstrapPayload = null;
    }
    if (this.deferredBootstrapPayload && this.deferredBootstrapPayload.revision !== revision) this.deferredBootstrapPayload = null;
    this.revision = revision;
  }

  async loadBootstrap(): Promise<SqlBootstrapPayload> {
    markPerformance("bootstrap-fetch:start");
    let response: Response;
    try {
      response = await this.request("/api/sql/bootstrap", this.bootstrapPayload?.status === "ready" ? {
        headers: { "if-none-match": `\"sql-bootstrap-${this.bootstrapPayload.revision}-${this.bootstrapPayload.migrationState ?? (this.bootstrapPayload.status === "ready" ? "ready" : "empty")}\"` },
      } : undefined);
    } finally {
      markPerformance("bootstrap-fetch:end");
      measurePerformance("bootstrap-fetch", "bootstrap-fetch:start", "bootstrap-fetch:end");
    }
    if (response.status === 304 && this.bootstrapPayload) return this.bootstrapPayload;
    if (!response.ok) throw new SqlHttpError(`SQL bootstrap failed (${response.status})`, response.status);
    const payload = this.validateBootstrap(await response.json());
    markPerformance("bootstrap-json:end");
    measurePerformance("bootstrap-json", "bootstrap-fetch:end", "bootstrap-json:end");
    this.revision = payload.revision;
    this.bootstrapPayload = payload;
    if (this.deferredBootstrapPayload && this.deferredBootstrapPayload.revision !== payload.revision) this.deferredBootstrapPayload = null;
    this.enabled = true;
    return payload;
  }

  async loadDeferredBootstrap(): Promise<SqlDeferredBootstrapPayload> {
    if (this.deferredBootstrapPayload?.revision === this.revision) return this.deferredBootstrapPayload;
    const response = await this.request('/api/sql/deferred-bootstrap');
    if (!response.ok) throw new SqlHttpError(`SQL deferred bootstrap failed (${response.status})`, response.status);
    const payload = this.validateDeferredBootstrap(await response.json());
    if (payload.revision !== this.revision) throw new Error('SQL deferred bootstrap revision changed');
    this.deferredBootstrapPayload = payload;
    return payload;
  }

  async init(): Promise<boolean> {
    if (this.enabled) return true;
    await this.loadBootstrap();
    this.enabled = true;
    return true;
  }

  async migrateLegacy(retry = false): Promise<{ status: "ready" | "failed"; revision: number }> {
    const response = await this.request(`/api/sql/migrate-legacy${retry ? "?retry=1" : ""}`, { method: "POST" });
    if (!response.ok) throw new SqlHttpError(`SQL legacy migration failed (${response.status})`, response.status);
    const result = await response.json() as { status?: unknown; revision?: unknown };
    const revision = Number(result.revision);
    if ((result.status !== "ready" && result.status !== "failed") || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("Invalid SQL legacy migration response");
    }
    this.bootstrapPayload = null;
    this.deferredBootstrapPayload = null;
    this.revision = revision;
    return { status: result.status, revision };
  }

  private rebuildBootstrap(payload: SqlBootstrapPayload): Database | null {
    if (payload.status !== "ready") return null;
    const database = {
      ...payload.settings,
      pluginCustomStorage: payload.pluginCustomStorage ?? {},
      botPresets: payload.botPresets ?? [],
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
    database.botPresetsId = Math.max(0, database.botPresets.findIndex(
      (preset) => preset.id === (payload.settings as { activeBotPresetId?: unknown }).activeBotPresetId,
    ));
    delete (database as unknown as Record<string, unknown>).activeBotPresetId;
    (database as Database & { selectedCharacterId?: string | null }).selectedCharacterId = payload.selectedCharacterId;
    (database as Database & { selectedChatId?: string | null }).selectedChatId = payload.selectedChatId;
    return database;
  }

  async loadRecoverySnapshot(): Promise<SqlLoadDatabaseResult | null> {
    const dump = await this.fetchDump();
    this.bootstrapPayload = null;
    this.deferredBootstrapPayload = null;
    const database = this.rebuild(dump);
    // The recovery snapshot is the complete graph, deferred keys included, so
    // it satisfies the gate on its own -- without this the recovery path would
    // leave every deferred key permanently unwritable.
    if (database) {
      markDeferredRootHydrationApplied(
        Object.keys(database as unknown as Record<string, unknown>)
          .filter((key) => DEFERRED_ROOT_KEYS.has(key)),
      );
    }
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
    markPerformance('bootstrap-rebuild:start');
    let database: Database | null;
    try {
      database = this.rebuildBootstrap(payload);
    } finally {
      markPerformance('bootstrap-rebuild:end');
      measurePerformance('bootstrap-rebuild', 'bootstrap-rebuild:start', 'bootstrap-rebuild:end');
    }
    return { status: payload.status, revision: payload.revision, database };
  }

  /**
   * Applies a deferred payload to `database` and reports which deferred root
   * keys it actually carried. Returns without touching the global readiness
   * flag: only the public `hydrateDeferredDatabase` below may flip that, and
   * only for the live database.
   */
  private applyDeferredPayload(
    database: Database,
    payload: SqlDeferredBootstrapPayload,
  ): string[] {
    Object.assign(database as object, payload.settings, {
      pluginCustomStorage: payload.pluginCustomStorage,
      botPresets: payload.botPresets,
    });
    const activePresetId = (this.bootstrapPayload?.settings as { activeBotPresetId?: unknown } | undefined)?.activeBotPresetId;
    database.botPresetsId = Math.max(0, payload.botPresets.findIndex(
      (preset) => preset.id === activePresetId,
    ));
    delete (database as unknown as Record<string, unknown>).activeBotPresetId;
    return Object.keys(payload.settings).filter((key) => DEFERRED_ROOT_KEYS.has(key));
  }

  /**
   * Hydrates the deferred half of the bootstrap and opens the deferred root
   * write gate. Resolves to the deferred keys the server actually returned; a
   * deferred key missing from that list simply has no stored row yet, which is
   * why the gate is one flag rather than a per-key check (a per-key gate would
   * make the first ever write to such a key impossible).
   */
  async hydrateDeferredDatabase(database: Database): Promise<string[]> {
    const payload = await this.loadDeferredBootstrap();
    const applied = this.applyDeferredPayload(database, payload);
    markDeferredRootHydrationApplied(applied);
    return applied;
  }

  async loadCharacterHydration(characterId: string): Promise<character | null> {
    const metric = runtimeMetrics.start("character-hydration");
    try {
    const response = await this.request(`/api/sql/characters/${encodeURIComponent(characterId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SQL character load failed (${response.status})`);
    const payload = await response.json() as { revision: number; character: character; characterBodyCollapsed?: unknown };
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !payload.character || typeof payload.character !== "object") {
      throw new Error("Invalid SQL character payload");
    }
    this.acceptReadRevision(payload.revision);
    // SAFE: `payload` (and therefore `payload.character`) was just produced
    // by `await response.json()` a few lines above — a freshly parsed JSON
    // tree that has never been touched by Svelte reactivity. `defineProperty`
    // here can never hit a `$state` proxy's `defineProperty` trap
    // (`state_descriptors_fixed`); the object only enters `DBState.db` later,
    // via `applyHydratedCharacter`'s plain assignment
    // `db.characters[currentIndex] = normalized` in sqlRuntimeHydration.ts,
    // by which point this property is already attached.
    if (payload.characterBodyCollapsed === true) Object.defineProperty(payload.character, "_sqlCharacterBodyCollapsed", { configurable: true, enumerable: false, value: true });
    return payload.character;
    } finally {
      runtimeMetrics.end(metric);
    }
  }

  async repairCollapsedCharacter(characterId: string): Promise<SqlCharacterRepairResult> {
    const response = await this.request(`/api/sql/characters/${encodeURIComponent(characterId)}/repair`, { method: "POST" });
    if (!response.ok) throw new Error(`SQL character repair failed (${response.status})`);
    const payload = await response.json() as { status?: unknown; revision?: unknown; reason?: unknown; backups?: unknown };
    const revision = Number(payload.revision);
    if ((payload.status !== "repaired" && payload.status !== "not-needed" && payload.status !== "unavailable") || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid SQL character repair response");
    this.acceptReadRevision(revision);
    const reason = typeof payload.reason === "string" ? payload.reason : undefined;
    const backups = parseRepairBackupCensus(payload.backups);
    const result: SqlCharacterRepairResult = { status: payload.status, revision };
    if (reason !== undefined) result.reason = reason;
    if (backups !== undefined) result.backups = backups;
    return result;
  }

  async loadChatHydration(chatId: string): Promise<SqlChatHydration | null> {
    const response = await this.request(`/api/sql/chats/${encodeURIComponent(chatId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`SQL chat load failed (${response.status})`);
    const payload = await response.json() as { revision: number; chat: Chat };
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !payload.chat || typeof payload.chat !== "object" || payload.chat.id !== chatId ||
      typeof (payload.chat as Chat & { characterId?: unknown }).characterId !== "string") {
      throw new Error("Invalid SQL chat payload");
    }
    this.acceptReadRevision(payload.revision);
    return payload;
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

  private async sendStatements(
    statements: Statement[],
    action: string,
    baseRevision = this.revision,
  ): Promise<SqlCommitResult> {
    const response = await this.request("/api/sql/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision, action, statements }),
    });
    if (response.status === 409) {
      const body = await response.json();
      this.revision = Number(body.currentRevision) || 0;
      this.bootstrapPayload = null;
      this.deferredBootstrapPayload = null;
      throw new SqlRevisionConflictError(this.revision);
    }
    if (!response.ok) throw new Error(`SQL commit failed (${response.status})`);
    const result = (await response.json()) as SqlCommitResult;
    this.revision = result.revision;
    this.bootstrapPayload = null;
    this.deferredBootstrapPayload = null;
    return result;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    const statements: Statement[] = [];
    if (commit.replaceAll) {
      statements.push(
        { sql: "DELETE FROM system_settings", bind: [] },
        { sql: "DELETE FROM characters", bind: [] },
      );
    }
    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });
    return await this.sendStatements(
      statements,
      commit.action || (commit.replaceAll ? "replace-all" : "sync"),
      commit.baseRevision,
    );
  }

  async replaceDatabase(database: Database): Promise<boolean> {
    await this.commit(buildSqlReplaceCommit(database, this.revision));
    return true;
  }

  /**
   * A throwaway full graph for the legacy single-domain read helpers below.
   * It deliberately does NOT open the deferred write gate: this database is
   * not the one the persistence runtime commits from, and opening the gate
   * here would declare the LIVE graph hydrated while it still is not.
   */
  private async current(): Promise<Database> {
    const database = (await this.loadDatabase({ shallow: true }))?.database ?? ({} as Database);
    this.applyDeferredPayload(database, await this.loadDeferredBootstrap());
    return database;
  }

  async loadCharacter(characterId: string): Promise<character | null> {
    return await this.loadCharacterHydration(characterId);
  }

  async loadChat(chatId: string, options?: { messageLimit?: number }): Promise<Chat | null> {
    const hydrated = await this.loadChatHydration(chatId);
    if (!hydrated) return null;
    const chat = hydrated.chat;
    if (!options?.messageLimit) return chat;
    const page = await this.loadChatMessageReversePage(chatId, undefined, options.messageLimit);
    if (page.revision !== hydrated.revision) throw new Error("SQL chat hydration revision changed");
    return { ...chat, message: page.messages };
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
      id: preset.id!, position, name: preset.name ?? "", image: preset.image ?? "",
      apiType: preset.apiType ?? "", aiModel: preset.aiModel ?? "", hash: "",
    }));
  }

  async loadBotPreset(id: string): Promise<StoredBotPreset | null> {
    const preset = ((await this.current()).botPresets ?? []).find((item) => item.id === id);
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
