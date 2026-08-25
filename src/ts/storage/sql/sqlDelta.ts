import { v4 as uuidv4 } from "uuid";

import type { Database, Message } from "../database.svelte";
import { flattenRelationalValue } from "./relationalNodeCodec";
import {
  createEmptySqlCommit,
  hasSqlCommitChanges,
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

function fingerprint(value: unknown): string {
  return JSON.stringify(flattenRelationalValue(value));
}

function sameValue(left: unknown, right: unknown): boolean {
  return fingerprint(left) === fingerprint(right);
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ensureMessageId(message: Message): string {
  message.chatId ||= uuidv4();
  return message.chatId;
}

/**
 * Compare two legacy-compatible object graphs and produce row-bounded writes.
 * This is deliberately independent of Svelte tracking: plugin mutations and
 * imports that replace nested objects are still detected before persistence.
 */
export function buildSqlDeltaCommit(
  previous: Database,
  current: Database,
  baseRevision: number,
): SqlCommit | null {
  const commit = createEmptySqlCommit(baseRevision, "sync");

  const rootKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of rootKeys) {
    if (ROOT_EXCLUSIONS.has(key)) continue;
    const hasPrevious = Object.prototype.hasOwnProperty.call(previous, key);
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, key);
    const nextValue = (current as any)[key];
    if (!hasCurrent || nextValue === undefined || typeof nextValue === "function") {
      if (hasPrevious) commit.root.deletes.push(key);
    } else if (!hasPrevious || !sameValue((previous as any)[key], nextValue)) {
      commit.root.upserts.push({ key, value: nextValue });
    }
  }

  const previousPlugin = previous.pluginCustomStorage ?? {};
  const currentPlugin = current.pluginCustomStorage ?? {};
  const pluginKeys = new Set([
    ...Object.keys(previousPlugin),
    ...Object.keys(currentPlugin),
  ]);
  const pluginUpserts: { key: string; value: unknown }[] = [];
  const pluginDeletes: string[] = [];
  for (const key of pluginKeys) {
    if (!(key in currentPlugin)) pluginDeletes.push(key);
    else if (!(key in previousPlugin) || !sameValue(previousPlugin[key], currentPlugin[key]))
      pluginUpserts.push({ key, value: currentPlugin[key] });
  }
  if (pluginUpserts.length || pluginDeletes.length) {
    commit.pluginStorage = { upserts: pluginUpserts, deletes: pluginDeletes };
  }

  const previousPresets = previous.botPresets ?? [];
  const currentPresets = current.botPresets ?? [];
  for (const preset of previousPresets) preset.id ||= uuidv4();
  for (const preset of currentPresets) preset.id ||= uuidv4();
  const previousPresetMap = new Map(previousPresets.map((preset) => [preset.id!, preset]));
  const currentPresetIds = currentPresets.map((preset) => preset.id!);
  const previousPresetIds = previousPresets.map((preset) => preset.id!);
  const presetUpserts = currentPresets.flatMap((preset, position) => {
    const old = previousPresetMap.get(preset.id!);
    return !old || !sameValue(old, preset) || previousPresetIds[position] !== preset.id
      ? [{ id: preset.id!, position, data: preset }]
      : [];
  });
  const presetDeletes = previousPresetIds.filter((id) => !currentPresetIds.includes(id));
  const previousActive = previousPresetIds[previous.botPresetsId ?? 0];
  const currentActive = currentPresetIds[current.botPresetsId ?? 0];
  if (
    presetUpserts.length ||
    presetDeletes.length ||
    !sameOrder(previousPresetIds, currentPresetIds) ||
    previousActive !== currentActive
  ) {
    commit.presets = {
      upserts: presetUpserts,
      deletes: presetDeletes,
      ...(!sameOrder(previousPresetIds, currentPresetIds)
        ? { order: currentPresetIds }
        : {}),
      ...(previousActive !== currentActive && currentActive
        ? { activeId: currentActive }
        : {}),
    };
  }

  const previousCharacters = previous.characters ?? [];
  const currentCharacters = current.characters ?? [];
  for (const item of previousCharacters) item.chaId ||= uuidv4();
  for (const item of currentCharacters) item.chaId ||= uuidv4();
  const previousCharacterMap = new Map(
    previousCharacters.map((item) => [item.chaId, item]),
  );
  const previousCharacterIds = previousCharacters.map((item) => item.chaId);
  const currentCharacterIds = currentCharacters.map((item) => item.chaId);
  if (!sameOrder(previousCharacterIds, currentCharacterIds)) {
    commit.characterIds = currentCharacterIds;
  }

  currentCharacters.forEach((character, characterPosition) => {
    const oldCharacter = previousCharacterMap.get(character.chaId);
    if (
      !oldCharacter ||
      previousCharacterIds[characterPosition] !== character.chaId ||
      !sameValue(sqlCharacterData(oldCharacter), sqlCharacterData(character))
    ) {
      commit.characters.push({
        id: character.chaId,
        position: characterPosition,
        data: sqlCharacterData(character),
      });
    }

    const oldChats = oldCharacter?.chats ?? [];
    const currentChats = character.chats ?? [];
    for (const chat of oldChats) chat.id ||= uuidv4();
    for (const chat of currentChats) chat.id ||= uuidv4();
    const oldChatMap = new Map(oldChats.map((chat) => [chat.id!, chat]));
    const oldChatIds = oldChats.map((chat) => chat.id!);
    const currentChatIds = currentChats.map((chat) => chat.id!);
    if (!sameOrder(oldChatIds, currentChatIds)) {
      commit.chatManifests.push({
        characterId: character.chaId,
        ids: currentChatIds,
      });
    }

    currentChats.forEach((chat, chatPosition) => {
      const oldChat = oldChatMap.get(chat.id!);
      if (
        !oldChat ||
        oldChatIds[chatPosition] !== chat.id ||
        !sameValue(sqlChatData(oldChat), sqlChatData(chat))
      ) {
        commit.chats.push({
          id: chat.id!,
          characterId: character.chaId,
          position: chatPosition,
          data: sqlChatData(chat),
        });
      }

      const oldMessages = oldChat?.message ?? [];
      const currentMessages = chat.message ?? [];
      const oldMessageIds = oldMessages.map(ensureMessageId);
      const currentMessageIds = currentMessages.map(ensureMessageId);
      if (!sameOrder(oldMessageIds, currentMessageIds)) {
        commit.messageManifests.push({ chatId: chat.id!, ids: currentMessageIds });
      }
      const oldMessageMap = new Map(
        oldMessages.map((message, index) => [oldMessageIds[index], message]),
      );
      currentMessages.forEach((message, position) => {
        const id = currentMessageIds[position];
        const oldMessage = oldMessageMap.get(id);
        if (
          !oldMessage ||
          oldMessageIds[position] !== id ||
          !sameValue(sqlMessageData(oldMessage), sqlMessageData(message))
        ) {
          commit.messages.push({
            id,
            chatId: chat.id!,
            position,
            data: sqlMessageData(message),
          });
        }
      });
    });
  });

  return hasSqlCommitChanges(commit) ? commit : null;
}
