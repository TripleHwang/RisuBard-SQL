import type { Chat, Database, Message, character } from "../database.svelte";
import type { DirtySnapshot } from "./dirtyRegistry";
import {
  createEmptySqlCommit,
  sqlCharacterData,
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "./sqlCommit";
import { getSqlPosition, getSqlWindow, setSqlPosition } from "./sqlRuntimeMeta";
import { planRootWrite } from "./rootWritePolicy";

const ROOT_EXCLUSIONS = new Set([
  "characters",
  "pluginCustomStorage",
  "botPresets",
  "botPresetsId",
]);

type RuntimeChat = Chat & {
  messagesLoaded?: boolean;
  messagesFullyLoaded?: boolean;
};
type PositionedMessage = Message;
type MessageLookup = { message: PositionedMessage; localPosition: number };

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
    getSqlWindow(chat)?.hasOlder === true;
}

function canonicalMessagePosition(
  chat: RuntimeChat,
  message: PositionedMessage,
  localPosition: number,
): number {
  if (!messageWindowIsIncomplete(chat)) return localPosition;
  const position = getSqlPosition(message);
  if (Number.isSafeInteger(position) && position! >= 0)
    return position!;
  throw new Error(`Dirty message ${message.chatId ?? "(missing id)"} is missing its canonical SQL position`);
}

function messageLookup(chat: RuntimeChat, requested: ReadonlySet<string>): Map<string, MessageLookup> {
  const lookup = new Map<string, MessageLookup>();
  for (const [localPosition, message] of (chat.message ?? []).entries()) {
    if (message.chatId && requested.has(message.chatId)) lookup.set(message.chatId, { message, localPosition });
  }
  return lookup;
}

function allocateAppendedPositions(chat: RuntimeChat): void {
  if (!messageWindowIsIncomplete(chat)) return;
  const messages = chat.message ?? [];
  let firstUnpositioned = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (!Number.isSafeInteger(getSqlPosition(messages[index] as PositionedMessage))) {
      firstUnpositioned = index;
      break;
    }
  }
  if (firstUnpositioned < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    if (Number.isSafeInteger(getSqlPosition(messages[index] as PositionedMessage))) return;
  }
  const window = getSqlWindow(chat);
  const nextPosition = window?.nextPosition;
  if (!Number.isSafeInteger(nextPosition) || nextPosition! < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    const message = messages[index] as PositionedMessage;
    setSqlPosition(message, nextPosition! + index - firstUnpositioned);
  }
  if (window) window.nextPosition = nextPosition! + messages.length - firstUnpositioned;
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

  // A root key that is merely ABSENT must never become a cascading DELETE for
  // user-owned content, and a deferred key must not be written in either
  // direction before hydration has landed. `planRootWrite` owns both rules;
  // see rootWritePolicy.ts for why the value alone cannot decide this.
  for (const key of dirty.rootKeys) {
    if (ROOT_EXCLUSIONS.has(key)) continue;
    const plan = planRootWrite(database as unknown as Record<string, unknown>, key);
    if (plan.action === "upsert") commit.root.upserts.push({ key, value: plan.value });
    else if (plan.action === "delete") commit.root.deletes.push(key);
  }

  for (const characterId of dirty.characterIds) {
    const found = findCharacter(database, characterId);
    if (!found) {
      commit.characterDeletes!.push(characterId);
      continue;
    }
    const [currentCharacter, position] = found;
    commit.characters.push({
      id: characterId,
      position,
      data: sqlCharacterData(currentCharacter),
      replaceBody: (currentCharacter as character & { detailsLoaded?: boolean }).detailsLoaded === true,
    });
  }

  for (const dirtyChat of dirty.chats) {
    const found = findChat(database, dirtyChat.chatId);
    if (!found || found[0].chaId !== dirtyChat.characterId) {
      const parent = findCharacter(database, dirtyChat.characterId)?.[0];
      if (dirtyChat.manifest && parent) {
        commit.chatManifests.push({
          characterId: dirtyChat.characterId,
          ids: (parent.chats ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)),
        });
      }
      continue;
    }
    const [, chat, , position] = found;
    commit.chats.push({
      id: dirtyChat.chatId,
      characterId: dirtyChat.characterId,
      position,
      data: sqlChatData(chat),
      replaceBody: (chat as Chat & { detailsLoaded?: boolean }).detailsLoaded === true,
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
    const runtimeChat = chat as RuntimeChat;
    allocateAppendedPositions(runtimeChat);
    const lookup = messageLookup(runtimeChat, new Set(group.messageIds));
    for (const messageId of group.messageIds) {
      const current = lookup.get(messageId);
      if (!current) continue;
      const { message, localPosition } = current;
      commit.messages.push({
        id: messageId,
        chatId: group.chatId,
        position: canonicalMessagePosition(runtimeChat, message, localPosition),
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

  const presetListDirty = dirty.rootKeys.includes("botPresets");
  const presetActiveDirty = dirty.rootKeys.includes("botPresetsId");
  if (dirty.presetIds.length || presetListDirty || presetActiveDirty) {
    const presets = database.botPresets ?? [];
    const upsertIds = presetListDirty
      ? presets.map((preset) => preset.id).filter((id): id is string => Boolean(id))
      : dirty.presetIds;
    const upserts = upsertIds.flatMap((id) => {
      const position = presets.findIndex((preset) => preset.id === id);
      return position < 0 ? [] : [{ id, position, data: presets[position] }];
    });
    const deletes = dirty.presetIds.filter((id) => !presets.some((preset) => preset.id === id));
    const ids = presets.map((preset) => preset.id).filter((id): id is string => Boolean(id));
    const activeIndex = Math.max(0, Math.min(Number(database.botPresetsId) || 0, ids.length - 1));
    const activeSelectionChanged = deletes.length > 0;
    commit.presets = {
      upserts,
      deletes,
      ...(presetListDirty ? { order: ids, manifest: true } : {}),
      ...(presetListDirty || presetActiveDirty || activeSelectionChanged
        ? { activeId: ids[activeIndex] ?? null }
        : {}),
    };
  }

  return commit;
}
