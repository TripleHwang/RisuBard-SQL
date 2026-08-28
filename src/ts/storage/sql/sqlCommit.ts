import { v4 as uuidv4 } from "uuid";

import type {
  botPreset,
  character,
  Chat,
  Database,
  Message,
} from "../database.svelte";
import { isRootKeyDeferred } from "./deferredRootKeys";

export interface SqlSettingUpsert {
  key: string;
  value: unknown;
}

export interface SqlEntityUpsert {
  id: string;
  position: number;
  data: unknown;
}

export interface SqlChatUpsert extends SqlEntityUpsert {
  characterId: string;
}

export interface SqlMessageUpsert extends SqlEntityUpsert {
  chatId: string;
}

export interface SqlPresetUpsert {
  id: string;
  position: number;
  data: botPreset;
}

/**
 * A bounded transaction produced at the mutation boundary. Normal commits
 * touch only changed rows; `replaceAll` is reserved for import and migration.
 */
export interface SqlCommit {
  baseRevision: number;
  idempotencyKey?: string;
  replaceAll?: boolean;
  action?: string;
  root: { upserts: SqlSettingUpsert[]; deletes: string[] };
  pluginStorage?: {
    upserts: SqlSettingUpsert[];
    deletes: string[];
    clear?: boolean;
  };
  presets?: {
    upserts: SqlPresetUpsert[];
    deletes: string[];
    order?: string[];
    /** Reconcile the stored list to order, including removal of absent IDs. */
    manifest?: boolean;
    activeId?: string | null;
  };
  characters: SqlEntityUpsert[];
  characterDeletes?: string[];
  characterIds?: string[];
  chats: SqlChatUpsert[];
  chatManifests: { characterId: string; ids: string[] }[];
  messages: SqlMessageUpsert[];
  messageManifests: { chatId: string; ids: string[] }[];
  messageDeletes?: { chatId: string; ids: string[] }[];
}

export interface SqlCommitResult {
  revision: number;
}

export class SqlRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`SQL revision conflict: current revision is ${currentRevision}`);
    this.name = "SqlRevisionConflictError";
  }
}

export function createEmptySqlCommit(
  baseRevision: number,
  action?: string,
): SqlCommit {
  return {
    baseRevision,
    action,
    root: { upserts: [], deletes: [] },
    characters: [],
    characterDeletes: [],
    chats: [],
    chatManifests: [],
    messages: [],
    messageManifests: [],
    messageDeletes: [],
  };
}

export function hasSqlCommitChanges(commit: SqlCommit): boolean {
  return Boolean(
    commit.root.upserts.length ||
      commit.root.deletes.length ||
      commit.pluginStorage?.upserts.length ||
      commit.pluginStorage?.deletes.length ||
      commit.pluginStorage?.clear ||
      commit.presets?.upserts.length ||
      commit.presets?.deletes.length ||
      commit.presets?.order ||
      commit.presets?.activeId !== undefined ||
      commit.characters.length ||
      commit.characterDeletes?.length ||
      commit.characterIds ||
      commit.chats.length ||
      commit.chatManifests.length ||
      commit.messages.length ||
      commit.messageManifests.length ||
      commit.messageDeletes?.length
  );
}

export function sqlCharacterData(value: character): unknown {
  const data = { ...value } as Record<string, unknown>;
  delete data.chats;
  delete data.chaId;
  delete data.detailsLoaded;
  return data;
}

export function sqlChatData(value: Chat): unknown {
  const data = { ...value } as Record<string, unknown>;
  delete data.message;
  delete data.id;
  delete data._placeholder;
  delete data.messagesLoaded;
  delete data.messagesFullyLoaded;
  delete data.messageOffset;
  delete data.messageTotal;
  delete data._sqlWindow;
  delete data.detailsLoaded;
  return data;
}

export function sqlMessageData(value: Message): unknown {
  const { chatId: _messageId, ...data } = value;
  return data;
}

function ensureId(value: { id?: string }): string {
  value.id ||= uuidv4();
  return value.id;
}

function ensureMessageId(message: Message): string {
  message.chatId ||= uuidv4();
  return message.chatId;
}

/** Build the one-time full replacement used by legacy import. */
export function buildSqlReplaceCommit(
  database: Database,
  baseRevision: number,
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, "replace-all");
  commit.replaceAll = true;
  commit.characterIds = [];

  // A replace-all clears `plugin_custom_storage` and rewrites it from this map.
  // Building it from a map that was never loaded would delete every row and
  // replace them with nothing. Throwing keeps the caller on its old source:
  // `selectCanonicalDatabase` catches this and preserves the legacy database.
  if (isRootKeyDeferred("pluginCustomStorage")) {
    throw new Error(
      "Refusing to build a replace-all SQL commit while pluginCustomStorage is deferred: " +
      "its rows exist in storage but are not loaded, so this commit would clear them. " +
      "Load the key first (ensureRootKeyHydrated) and retry.",
    );
  }
  database.pluginCustomStorage ??= {};
  commit.pluginStorage = {
    upserts: Object.entries(database.pluginCustomStorage).map(([key, value]) => ({
      key,
      value,
    })),
    deletes: [],
    clear: true,
  };

  const presets = Array.isArray(database.botPresets) ? database.botPresets : [];
  const presetIds = presets.map((preset) => {
    preset.id ||= uuidv4();
    return preset.id;
  });
  if (presets.length) {
    const activeIndex = Math.max(
      0,
      Math.min(Number(database.botPresetsId) || 0, presets.length - 1),
    );
    commit.presets = {
      upserts: presets.map((data, position) => ({
        id: presetIds[position],
        position,
        data,
      })),
      deletes: [],
      order: presetIds,
      activeId: presetIds[activeIndex],
    };
  }

  for (const [key, value] of Object.entries(database)) {
    if (
      key !== "characters" &&
      key !== "pluginCustomStorage" &&
      key !== "botPresets" &&
      key !== "botPresetsId" &&
      value !== undefined &&
      typeof value !== "function"
    ) {
      commit.root.upserts.push({ key, value });
    }
  }

  database.characters.forEach((currentCharacter, characterPosition) => {
    currentCharacter.chaId ||= uuidv4();
    commit.characterIds!.push(currentCharacter.chaId);
    commit.characters.push({
      id: currentCharacter.chaId,
      position: characterPosition,
      data: sqlCharacterData(currentCharacter),
    });

    const chats = currentCharacter.chats ?? [];
    const chatIds = chats.map(ensureId);
    commit.chatManifests.push({
      characterId: currentCharacter.chaId,
      ids: chatIds,
    });

    chats.forEach((chat, chatPosition) => {
      const chatId = chatIds[chatPosition];
      commit.chats.push({
        id: chatId,
        characterId: currentCharacter.chaId,
        position: chatPosition,
        data: sqlChatData(chat),
      });
      const messages = chat.message ?? [];
      const messageIds = messages.map(ensureMessageId);
      commit.messageManifests.push({ chatId, ids: messageIds });
      messages.forEach((message, position) => {
        commit.messages.push({
          id: messageIds[position],
          chatId,
          position,
          data: sqlMessageData(message),
        });
      });
    });
  });

  return commit;
}
