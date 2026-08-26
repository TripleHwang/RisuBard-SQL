import type { Chat, Database, Message, character } from "../database.svelte";
import type { DirtySnapshot } from "./dirtyRegistry";
import {
  createEmptySqlCommit,
  sqlCharacterData,
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "./sqlCommit";

const ROOT_EXCLUSIONS = new Set([
  "characters",
  "pluginCustomStorage",
  "botPresets",
  "botPresetsId",
]);

type RuntimeChat = Chat & {
  messagesLoaded?: boolean;
  messagesFullyLoaded?: boolean;
  _sqlWindow?: { hasOlder?: boolean };
};
type PositionedMessage = Message & { _sqlPosition?: number };

function findCharacter(database: Database, characterId: string): [character, number] | undefined {
  const position = (database.characters ?? []).findIndex((item) => item.chaId === characterId);
  return position < 0 ? undefined : [database.characters[position], position];
}

function findChat(database: Database, chatId: string): [character, Chat, number, number] | undefined {
  for (const [characterPosition, currentCharacter] of (database.characters ?? []).entries()) {
    const chatPosition = (currentCharacter.chats ?? []).findIndex((chat) => chat.id === chatId);
    if (chatPosition >= 0) return [currentCharacter, currentCharacter.chats[chatPosition], characterPosition, chatPosition];
  }
  return undefined;
}

function messageWindowIsIncomplete(chat: RuntimeChat): boolean {
  return chat.messagesLoaded === false ||
    chat.messagesFullyLoaded === false ||
    chat._sqlWindow?.hasOlder === true;
}

function canonicalMessagePosition(chat: RuntimeChat, message: PositionedMessage, localPosition: number): number {
  if (!messageWindowIsIncomplete(chat)) return localPosition;
  if (Number.isSafeInteger(message._sqlPosition) && message._sqlPosition! >= 0)
    return message._sqlPosition!;
  throw new Error(`Dirty message ${message.chatId ?? "(missing id)"} is missing its canonical SQL position`);
}

/**
 * Builds a transaction from only the scopes explicitly marked dirty. It never
 * compares the complete legacy graph; incomplete hydrated message windows use
 * the non-enumerable canonical position attached by SQL page hydration.
 */
export function buildSqlDirtyCommit(
  database: Database,
  dirty: DirtySnapshot,
  baseRevision: number,
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, "dirty-sync");

  for (const key of dirty.rootKeys) {
    if (ROOT_EXCLUSIONS.has(key)) continue;
    const value = (database as unknown as Record<string, unknown>)[key];
    if (value === undefined || typeof value === "function") commit.root.deletes.push(key);
    else commit.root.upserts.push({ key, value });
  }

  for (const characterId of dirty.characterIds) {
    const found = findCharacter(database, characterId);
    if (!found) continue;
    const [currentCharacter, position] = found;
    commit.characters.push({ id: characterId, position, data: sqlCharacterData(currentCharacter) });
  }

  for (const dirtyChat of dirty.chats) {
    const found = findChat(database, dirtyChat.chatId);
    if (!found || found[0].chaId !== dirtyChat.characterId) continue;
    const [, chat, , position] = found;
    commit.chats.push({
      id: dirtyChat.chatId,
      characterId: dirtyChat.characterId,
      position,
      data: sqlChatData(chat),
    });
    if (dirtyChat.manifest) {
      commit.chatManifests.push({
        characterId: dirtyChat.characterId,
        ids: (found[0].chats ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)),
      });
    }
  }

  for (const group of dirty.messages) {
    const found = findChat(database, group.chatId);
    if (!found) continue;
    const [, chat] = found;
    for (const messageId of group.messageIds) {
      const localPosition = (chat.message ?? []).findIndex((message) => message.chatId === messageId);
      if (localPosition < 0) continue;
      const message = chat.message[localPosition] as PositionedMessage;
      commit.messages.push({
        id: messageId,
        chatId: group.chatId,
        position: canonicalMessagePosition(chat as RuntimeChat, message, localPosition),
        data: sqlMessageData(message),
      });
    }
  }

  for (const chatId of dirty.messageManifestChatIds) {
    const found = findChat(database, chatId);
    if (!found || messageWindowIsIncomplete(found[1] as RuntimeChat)) continue;
    commit.messageManifests.push({
      chatId,
      ids: (found[1].message ?? []).map((message) => message.chatId).filter((id): id is string => Boolean(id)),
    });
  }

  for (const deletion of dirty.messageDeletes) {
    if (deletion.messageIds.length)
      commit.messageDeletes!.push({ chatId: deletion.chatId, ids: [...deletion.messageIds] });
  }

  if (dirty.pluginStorageKeys.length) {
    const storage = database.pluginCustomStorage ?? {};
    const upserts = dirty.pluginStorageKeys.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(storage, key) ? [{ key, value: storage[key] }] : [],
    );
    const deletes = dirty.pluginStorageKeys.filter((key) => !Object.prototype.hasOwnProperty.call(storage, key));
    commit.pluginStorage = { upserts, deletes };
  }

  if (dirty.presetIds.length) {
    const presets = database.botPresets ?? [];
    const upserts = dirty.presetIds.flatMap((id) => {
      const position = presets.findIndex((preset) => preset.id === id);
      return position < 0 ? [] : [{ id, position, data: presets[position] }];
    });
    const deletes = dirty.presetIds.filter((id) => !presets.some((preset) => preset.id === id));
    commit.presets = { upserts, deletes };
  }

  return commit;
}
