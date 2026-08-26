import type {
  botPreset,
  character,
  Chat,
  customscript,
  Database,
  loreBook,
  Message,
  RisuPersona,
} from "../database.svelte";
import type { RisuModule } from "../../process/modules";
import type { SqlCommit, SqlCommitResult } from "./sqlCommit";

export type SqlBackendKind = "web-sqlite" | "native-sqlite" | "server-sql";

export interface SqlLoadDatabaseOptions {
  /**
   * Backends may return metadata-only entities once their lazy loaders have
   * passed the compatibility suite. Until then they must return a full graph.
   */
  shallow?: boolean;
}

export interface SqlLoadDatabaseResult {
  status: "ready" | "empty";
  revision: number;
  database: Database | null;
}

export interface SqlChatLoadOptions {
  messageLimit?: number;
}

export interface SqlMessagePage {
  messages: Message[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export type StoredBotPreset = botPreset & { id: string };

export interface SqlBootstrapPayload {
  status: "ready" | "empty";
  revision: number;
  settings: Record<string, unknown>;
  pluginCustomStorage: Record<string, unknown>;
  botPresets: StoredBotPreset[];
  characters: character[];
  selectedCharacterId: string | null;
  selectedChatId: string | null;
}

export interface SqlReverseMessagePage {
  revision: number;
  chatId: string;
  messages: Message[];
  before: number | null;
  nextBefore: number | null;
  total: number;
  hasMore: boolean;
}

export interface BotPresetSummary {
  id: string;
  position: number;
  name: string;
  image: string;
  apiType: string;
  aiModel: string;
  hash: string;
}

export interface SqlRevision {
  id: number;
  action: string;
  [key: string]: unknown;
}

export interface SqlRevisionDetails extends SqlRevision {
  [key: string]: unknown;
}

export interface SqlRevisionDiff {
  [key: string]: unknown;
}

export interface SqlRestorePreview {
  [key: string]: unknown;
}

export interface SqlMessageSearchResult {
  [key: string]: unknown;
}

export interface SqlTokenUsage {
  [key: string]: unknown;
}

export interface SqlCharacterSearchResult {
  [key: string]: unknown;
}

export interface SqlBotChatStats {
  [key: string]: unknown;
}

/**
 * Storage contract shared by every standalone backend. Callers never branch
 * on database.bin, OPFS, or a native driver; those are implementation details.
 */
export interface ISqlStorage {
  readonly backendKind: SqlBackendKind;
  isEnabled(): boolean;
  getRevision(): number;
  init(): Promise<boolean>;

  loadDatabase(options?: SqlLoadDatabaseOptions): Promise<SqlLoadDatabaseResult | null>;
  commit(commit: SqlCommit): Promise<SqlCommitResult>;
  replaceDatabase(
    database: Database,
    onProgress?: (status: string) => void,
  ): Promise<boolean>;

  loadCharacter(characterId: string): Promise<character | null>;
  loadChat(chatId: string, options?: SqlChatLoadOptions): Promise<Chat | null>;
  loadChatMessages(
    chatId: string,
    options?: { mode?: "full" | "generation" },
  ): Promise<Message[]>;
  loadChatMessagePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlMessagePage>;

  loadPersonas(): Promise<RisuPersona[]>;
  listBotPresets(): Promise<BotPresetSummary[]>;
  loadBotPreset(id: string): Promise<StoredBotPreset | null>;
  loadLorebooks(): Promise<{ name: string; data: loreBook[] }[]>;
  loadModules(): Promise<RisuModule[]>;
  loadPrompts(): Promise<Record<string, unknown>>;
  loadScripts(): Promise<customscript[]>;

  loadPlugins(): Promise<unknown[] | null>;
  loadPluginCustomStorage(): Promise<Record<string, unknown> | null>;
  listPluginCustomStorageKeys(): Promise<string[]>;
  loadPluginCustomStorageKey(key: string): Promise<unknown>;
  loadSettingKey(key: string): Promise<unknown>;

  /** Ephemeral composer state is still user data, so it lives in the canonical
   * database instead of a sidecar KV store when standalone SQL is active. */
  getChatDraft(key: string): Promise<{ m: string; t: string } | null>;
  listChatDraftKeys(): Promise<string[]>;
  setChatDraft(key: string, draft: { m: string; t: string }): Promise<void>;
  removeChatDrafts(keys: string[]): Promise<number>;

  getColdStorageItem(key: string): Promise<unknown | null>;
  listColdStorageItems(): Promise<{ items: string[] }>;
  setColdStorageItem(key: string, value: unknown): Promise<boolean>;
  removeColdStorageItems(keys: string[]): Promise<number>;
  pruneColdStorage(retainedKeys: string[]): Promise<number>;

  listRevisions(limit?: number): Promise<SqlRevision[]>;
  getRevisionDetails?(revisionId: number): Promise<SqlRevisionDetails | null>;
  getRevisionDiff?(baseId: number, targetId: number): Promise<SqlRevisionDiff | null>;
  previewRestoreRevision?(revisionId: number): Promise<SqlRestorePreview | null>;
  restoreRevision(revisionId: number): Promise<{ revision: number; revisionId: number }>;

  searchMessages(
    query: string,
    scope?: "all" | "active" | "cold",
    limit?: number,
  ): Promise<SqlMessageSearchResult[]>;
  getTokenUsage(): Promise<SqlTokenUsage[]>;
  getBotChatStats(): Promise<SqlBotChatStats[]>;
  searchCharactersByTag(tag: string, limit?: number): Promise<SqlCharacterSearchResult[]>;
  searchCharactersByName(name: string, limit?: number): Promise<SqlCharacterSearchResult[]>;
}

/** Additive bounded read contract used only by the Node SQL client. */
export interface SqlBootstrapStorage extends ISqlStorage {
  loadBootstrap(): Promise<SqlBootstrapPayload>;
  loadRecoverySnapshot(): Promise<SqlLoadDatabaseResult | null>;
  loadCharacterHydration(characterId: string): Promise<character | null>;
  loadChatMessageReversePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlReverseMessagePage>;
}
