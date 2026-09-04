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
  /**
   * Absent when the client asked for `pluginCustomStorage` to be deferred and
   * the server honoured it (the key is then named in `deferredRootKeys`).
   * Absence here is "not loaded", never "the user has no plugin storage".
   */
  pluginCustomStorage?: Record<string, unknown>;
  botPresets: StoredBotPreset[];
  characters: character[];
  selectedCharacterId: string | null;
  selectedChatId: string | null;
  /**
   * Root keys the server withheld from `settings` because the client asked it
   * to. These keys EXIST in storage; their absence from `settings` is "not
   * loaded", never "not present". Absent or empty means nothing was deferred.
   */
  deferredRootKeys?: string[];
  /**
   * Keys the client asked to defer that are not stored at all. Reported so the
   * client can tell them apart from `deferredRootKeys`; they are genuinely
   * absent and must NOT be treated as deferred.
   */
  absentDeferredRootKeys?: string[];
  /**
   * Keys registered in storage that rebuilt to no value -- a storage fault, not
   * a deletion. `undefined` does not survive JSON, so these arrive
   * indistinguishable from absent unless the server names them. They exist, so
   * the client must treat them as deferred rather than as deletable.
   */
  unreadableRootKeys?: string[];
}

export interface SqlReverseMessagePage {
  revision: number;
  chatId: string;
  messages: Message[];
  /** Exact persisted positions, parallel to messages. They are not local window indexes. */
  positions: number[];
  /** First unused persisted position, safe for appending after a sparse page. */
  nextPosition: number;
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
  /**
   * Fetch one chat's own stored fields -- everything on the `Chat` shape except
   * its messages.
   *
   * `null` means the server does not have this chat, and only that. Every other
   * failure rejects: a chat whose read failed must stay marked
   * `detailsLoaded: false`, because the alternative is a summary that claims to
   * be complete and is then written back over the stored row.
   *
   * The returned `message` array is always empty. Messages come from
   * {@link loadChatMessageReversePage}; this call is the settings.
   */
  loadChatHydration(chatId: string): Promise<Chat | null>;
  loadChatMessageReversePage(
    chatId: string,
    before: number | undefined,
    limit: number,
  ): Promise<SqlReverseMessagePage>;
  /**
   * Fetch one deferred root key's real value. Rejects rather than resolving to
   * `undefined`: a deferred key is known to exist, so "could not determine" must
   * never collapse into a value that reads as empty.
   */
  loadRootKeyHydration(key: string): Promise<unknown>;
  /**
   * Read one plugin storage row, keeping existence and value apart.
   *
   * `{ present: false }` means the row is not in the table. It is the only
   * answer that may be read as "the plugin never stored this"; a transport
   * failure rejects instead, because a plugin told "you have nothing" writes a
   * fresh empty state over the rows it could not see.
   *
   * Distinct from {@link loadRootKeyHydration}: that one installs a whole
   * deferred root key into the live database and clears its deferred mark. This
   * one hands back a single value and installs nothing, so
   * `pluginCustomStorage` stays deferred and every whole-map reader keeps
   * refusing rather than reading a partial map as a complete one.
   */
  readPluginStorageKey(key: string): Promise<{ present: boolean; value: unknown }>;
}
