import type {
  BotPresetSummary,
  ISqlStorage,
  SqlBotChatStats,
  SqlCharacterSearchResult,
  SqlLoadDatabaseOptions,
  SqlLoadDatabaseResult,
  SqlMessagePage,
  SqlMessageSearchResult,
  SqlRevision,
  SqlTokenUsage,
  StoredBotPreset,
} from "./ISqlStorage";
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

function sorted(rows: Record<string, unknown>[], key = "position") {
  return [...rows].sort((left, right) => Number(left[key]) - Number(right[key]));
}

/** Browser client for the standalone Node server's native SQLite database. */
export class NodeSqliteStorage implements ISqlStorage {
  readonly backendKind = "server-sql" as const;
  private enabled = false;
  private revision = 0;
  private initialDump: ServerDump | null = null;

  constructor(private readonly request: AuthenticatedRequest) {}

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

  async init(): Promise<boolean> {
    if (this.enabled) return true;
    this.initialDump = await this.fetchDump();
    this.enabled = true;
    return true;
  }

  private async dump(): Promise<ServerDump> {
    if (!this.enabled) await this.init();
    if (this.initialDump) {
      const value = this.initialDump;
      this.initialDump = null;
      return value;
    }
    return await this.fetchDump();
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

  async loadDatabase(
    _options?: SqlLoadDatabaseOptions,
  ): Promise<SqlLoadDatabaseResult | null> {
    const dump = await this.dump();
    const database = this.rebuild(dump);
    return {
      status: database ? "ready" : "empty",
      revision: dump.revision,
      database,
    };
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
      throw new SqlRevisionConflictError(this.revision);
    }
    if (!response.ok) throw new Error(`SQL commit failed (${response.status})`);
    const result = (await response.json()) as SqlCommitResult;
    this.revision = result.revision;
    this.initialDump = null;
    return result;
  }

  async commit(commit: SqlCommit): Promise<SqlCommitResult> {
    const statements: Statement[] = [];
    if (commit.replaceAll) {
      statements.push(
        { sql: "DELETE FROM system_settings", bind: [] },
        { sql: "DELETE FROM plugin_custom_storage", bind: [] },
        { sql: "DELETE FROM characters", bind: [] },
        { sql: "DELETE FROM bot_presets", bind: [] },
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

  private async current(): Promise<Database> {
    return (await this.loadDatabase({ shallow: false }))?.database ?? ({} as Database);
  }

  async loadCharacter(characterId: string): Promise<character | null> {
    return (await this.current()).characters?.find((item) => item.chaId === characterId) ?? null;
  }

  async loadChat(chatId: string, options?: { messageLimit?: number }): Promise<Chat | null> {
    for (const character of (await this.current()).characters ?? []) {
      const chat = character.chats?.find((item) => item.id === chatId);
      if (chat) {
        if (options?.messageLimit && chat.message.length > options.messageLimit) {
          return { ...chat, message: chat.message.slice(-options.messageLimit) };
        }
        return chat;
      }
    }
    return null;
  }

  async loadChatMessages(chatId: string): Promise<Message[]> {
    return (await this.loadChat(chatId))?.message ?? [];
  }

  async loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage> {
    const messages = await this.loadChatMessages(chatId);
    const end = Math.min(messages.length, before ?? messages.length);
    const offset = Math.max(0, end - Math.max(1, limit));
    return {
      messages: messages.slice(offset, end),
      offset,
      total: messages.length,
      hasMore: offset > 0,
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
    const dump = await this.dump();
    const row = (dump.tables.chat_drafts ?? []).find((item) => item.draft_key === key);
    return row ? { m: String(row.message_text ?? ""), t: String(row.translate_text ?? "") } : null;
  }

  async listChatDraftKeys(): Promise<string[]> {
    return (await this.dump()).tables.chat_drafts?.map((row) => row.draft_key as string) ?? [];
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
    const dump = await this.dump();
    return this.nodes(
      dump,
      "cold_extension_nodes",
      (row) => row.archive_id === key,
    ) ?? null;
  }

  async listColdStorageItems(): Promise<{ items: string[] }> {
    return {
      items: (await this.dump()).tables.cold_archives?.map((row) => row.archive_id as string) ?? [],
    };
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
    const rows = sorted((await this.dump()).tables.system_revisions ?? [], "id").reverse();
    return rows.slice(0, limit).map((row) => ({
      ...row,
      id: Number(row.id),
      action: String(row.action ?? "sync"),
    }));
  }

  async restoreRevision(revisionId: number) {
    return { revision: this.revision, revisionId };
  }

  async searchMessages(query: string, _scope = "all", limit = 50): Promise<SqlMessageSearchResult[]> {
    const dump = await this.dump();
    const needle = query.toLocaleLowerCase();
    return (dump.tables.messages ?? [])
      .filter((row) => String(row.content_text ?? "").toLocaleLowerCase().includes(needle))
      .slice(0, limit)
      .map((row) => ({
        storageState: "active",
        chatId: row.chat_id,
        messageId: row.id,
        position: row.position,
        role: row.role,
        snippet: String(row.content_text ?? "").slice(0, 200),
      }));
  }

  async getTokenUsage(): Promise<SqlTokenUsage[]> {
    return [];
  }

  async getBotChatStats(): Promise<SqlBotChatStats[]> {
    return [];
  }

  async searchCharactersByTag(tag: string, limit = 100): Promise<SqlCharacterSearchResult[]> {
    const database = await this.current();
    return (database.characters ?? [])
      .filter((item) => item.tags?.some((value) => value.includes(tag)))
      .slice(0, limit)
      .map((item) => ({ id: item.chaId, name: item.name, image: item.image ?? null }));
  }

  async searchCharactersByName(name: string, limit = 100): Promise<SqlCharacterSearchResult[]> {
    const needle = name.toLocaleLowerCase();
    return ((await this.current()).characters ?? [])
      .filter((item) => item.name.toLocaleLowerCase().includes(needle))
      .slice(0, limit)
      .map((item) => ({ id: item.chaId, name: item.name, image: item.image ?? null }));
  }
}
