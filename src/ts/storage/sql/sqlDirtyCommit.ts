import type { Chat, Database, Message, character } from "../database.svelte";
import { isRootKeyDeferred, refuseDeferredRootDelete } from "./deferredRootKeys";
import type { DirtySnapshot } from "./dirtyRegistry";
import {
  getSqlPosition,
  getSqlWindow,
  isSqlWindowPartial,
  setSqlPosition,
  setSqlWindow,
} from "./sqlRuntimeWindow";
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
    isSqlWindowPartial(chat);
}

function canonicalMessagePosition(
  chat: RuntimeChat,
  message: PositionedMessage,
  localPosition: number,
): number {
  if (!messageWindowIsIncomplete(chat)) return localPosition;
  const canonical = getSqlPosition(message);
  if (Number.isSafeInteger(canonical) && canonical! >= 0) return canonical!;
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
    if (!Number.isSafeInteger(getSqlPosition(messages[index]))) {
      firstUnpositioned = index;
      break;
    }
  }
  if (firstUnpositioned < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    if (Number.isSafeInteger(getSqlPosition(messages[index]))) return;
  }
  const window = getSqlWindow(chat);
  const nextPosition = window?.nextPosition;
  if (!Number.isSafeInteger(nextPosition) || nextPosition! < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    setSqlPosition(messages[index], nextPosition! + index - firstUnpositioned);
  }
  // Replace the window rather than mutating the stored one in place. The chat
  // is a live `$state` object, so the window read back through it is a proxy of
  // what hydration stored; writing a whole new window keeps the advance atomic
  // and keeps every reader on a consistent snapshot.
  if (window) setSqlWindow(chat, { ...window, nextPosition: nextPosition! + messages.length - firstUnpositioned });
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
  /**
   * Called instead of throwing when one dirty message cannot be given a
   * canonical position. Omit it and the throw stands; pass it and the row is
   * left out of this commit and reported, so it cannot take the rest of the
   * transaction -- every other chat included -- down with it.
   */
  onRefusedMessage?: (chatId: string, messageId: string, error: unknown) => void,
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, "dirty-sync");

  for (const key of dirty.rootKeys) {
    if (ROOT_EXCLUSIONS.has(key)) continue;
    const value = (database as unknown as Record<string, unknown>)[key];
    const missing = value === undefined || typeof value === "function";
    // "not loaded" and "not present" are different states. Only the second may
    // become a DELETE; a deferred key that got this far was marked dirty by a
    // diff that mistook partial knowledge for a deletion.
    if (missing && isRootKeyDeferred(key)) {
      refuseDeferredRootDelete(key, "buildSqlDirtyCommit");
      continue;
    }
    if (missing) commit.root.deletes.push(key);
    else commit.root.upserts.push({ key, value });
  }

  for (const characterId of dirty.characterIds) {
    const found = findCharacter(database, characterId);
    if (!found) {
      commit.characterDeletes!.push(characterId);
      continue;
    }
    const [currentCharacter, position] = found;
    // A character that has not been hydrated is a bootstrap summary: name,
    // image, chat list, timestamps -- and no description, no first message, no
    // lorebook, no scripts. Writing one back replaces the real record with it.
    //
    // Reachable on any ordinary launch, because auditSqlCompatibilityDatabase
    // marks EVERY character dirty when the character order changes
    // (sqlPersistenceRuntime.ts:352), summaries included. The user opens the
    // app, something reorders, and each character that had not been opened yet
    // loses everything but its name.
    //
    // Skipped rather than thrown: this builder runs inside a retry loop, so
    // throwing would stop characters, chats and messages from ever persisting.
    if ((currentCharacter as { detailsLoaded?: boolean }).detailsLoaded === false) {
      console.error(
        `[SQL dirty commit] refusing to write character ${characterId} from a bootstrap summary: ` +
        "its description, first message, lorebook and scripts are not loaded, so this write " +
        "would replace the stored record with a stub. The character stays as storage has it.",
      );
      continue;
    }
    commit.characters.push({ id: characterId, position, data: sqlCharacterData(currentCharacter) });
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
      let position: number;
      try {
        position = canonicalMessagePosition(runtimeChat, message, localPosition);
      } catch (error) {
        // Without `onRefusedMessage` this still throws, and the throw is right:
        // a dirty row in a partial window with no canonical position must never
        // be written at a guessed one. What was wrong was where the throw
        // landed. `commitDirtyScopes` builds outside its try, so one such row
        // aborted the ENTIRE commit -- every other chat's pending edits with
        // it -- and the 5s retry rebuilt the same snapshot and threw again,
        // every five seconds, forever, with nothing but console output. One
        // un-positionable message meant nothing in the application ever
        // persisted again.
        //
        // Refusing just this row keeps that invariant and costs it only itself:
        // the caller leaves it dirty so it retries, and everything else in the
        // flush gets written.
        if (!onRefusedMessage) throw error;
        onRefusedMessage(group.chatId, messageId, error);
        continue;
      }
      commit.messages.push({
        id: messageId,
        chatId: group.chatId,
        position,
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
    // `pluginCustomStorage` never travels as a root key (see ROOT_EXCLUSIONS);
    // its rows are their own scope, and a dirty key that is not in the map
    // becomes a row DELETE. While the map is deferred it is not in memory at
    // all, so every dirty key would look absent -- partial knowledge read as a
    // definite negative, on the exact scope that lost a user's plugin list.
    const pluginStorageDeferred = isRootKeyDeferred("pluginCustomStorage");
    const storage = database.pluginCustomStorage ?? {};
    const upserts: Array<{ key: string; value: unknown }> = [];
    const deletes: string[] = [];
    for (const key of dirty.pluginStorageKeys) {
      // A value we can actually see is committed either way: a write that
      // landed while the map was deferred is still the user's own edit.
      if (Object.prototype.hasOwnProperty.call(storage, key)) {
        upserts.push({ key, value: storage[key] });
        continue;
      }
      if (pluginStorageDeferred) {
        refuseDeferredRootDelete(`pluginCustomStorage[${key}]`, "buildSqlDirtyCommit:pluginStorage");
        continue;
      }
      deletes.push(key);
    }
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
