import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";
import { chatHydrationKey } from "../chatHydrationKey";
import { validateOlderMessagePage } from "../../chatWindow";
import { getSqlWindow, setSqlPosition, setSqlWindow, type SqlHydrationWindow } from "./sqlRuntimeMeta";
import { language } from "src/lang";

export type { SqlHydrationWindow };
type HydratableCharacter = character & { detailsLoaded?: boolean };
type CollapsedCharacter = character & { _sqlCharacterBodyCollapsed?: boolean };
type HydratableChat = Chat & { messagesLoaded?: boolean; messagesFullyLoaded?: boolean };

/**
 * Metadata bootstrap deliberately does not mutate partial character summaries.
 * This normalizer is called only after the complete record response arrives;
 * selection subsequently applies the broader legacy character migration.
 */
export function normalizeHydratedCharacter(value: character): character {
  value.chats ??= [];
  value.chatPage ??= 0;
  value.customscript ??= [];
  value.globalLore ??= [];
  value.emotionImages ??= [];
  (value as HydratableCharacter).detailsLoaded = true;
  return value;
}

const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_CHAT_HYDRATION_ATTEMPTS = 2;
const characterHydrations = new Map<string, Promise<character | null>>();
const chatHydrations = new Map<string, Promise<Chat | null>>();
const chatBodyHydrations = new Map<string, Promise<Chat | null>>();
type RevisionedChat = Chat & {
  _sqlHydrationRevision?: number;
  _sqlMetadataOverrides?: Record<string, unknown>;
};
const CHAT_METADATA_KEYS = ["name", "note", "folderId", "lastDate"] as const;
function metadataSnapshot(chat: Chat): Record<string, unknown> {
  return Object.fromEntries(CHAT_METADATA_KEYS.flatMap((key) => Object.prototype.hasOwnProperty.call(chat, key) ? [[key, (chat as unknown as Record<string, unknown>)[key]]] : []));
}
function metadataChanges(chat: Chat, baseline: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CHAT_METADATA_KEYS.flatMap((key) => Object.prototype.hasOwnProperty.call(chat, key) && !Object.is((chat as unknown as Record<string, unknown>)[key], baseline[key]) ? [[key, (chat as unknown as Record<string, unknown>)[key]]] : []));
}

function getNodeBootstrapStorage(): SqlBootstrapStorage | null {
  const storage = getActiveSqlStorage();
  if (storage?.backendKind !== "server-sql" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadCharacterHydration !== "function" ||
      typeof (storage as Partial<SqlBootstrapStorage>).loadChatMessageReversePage !== "function") {
    return null;
  }
  return storage as SqlBootstrapStorage;
}

function normalizeLimit(limit?: number): number {
  return Math.min(100, Math.max(1, Math.floor(limit ?? DEFAULT_MESSAGE_LIMIT)));
}

function setWindow(chat: Chat, window: SqlHydrationWindow): void {
  setSqlWindow(chat, window);
}

function getWindow(chat: Chat): SqlHydrationWindow | undefined {
  return getSqlWindow(chat);
}

function attachCanonicalPositions(messages: Chat["message"], positions: number[] | undefined): void {
  if (!positions || positions.length !== messages.length) return;
  for (const [index, message] of messages.entries()) {
    setSqlPosition(message, positions[index]);
  }
}

/**
 * Reverse pages are a different contract from forward hydration: every page
 * must terminate exactly at the persisted boundary we asked for. Validate the
 * response before attaching positions or replacing either observable window.
 */
function validateOlderReversePage(
  page: Awaited<ReturnType<SqlBootstrapStorage["loadChatMessageReversePage"]>>,
  window: SqlHydrationWindow,
  knownIds: Set<string | undefined>,
): void {
  if (page.total !== window.total || page.before !== window.nextBefore || page.nextPosition !== window.nextPosition) {
    throw new Error("Reverse page metadata changed")
  }
  if (!Array.isArray(page.positions) || page.positions.length !== page.messages.length) {
    throw new Error("Reverse page positions are invalid")
  }
  const seen = new Set<string>()
  let previous = -Infinity
  for (const [index, message] of page.messages.entries()) {
    const id = message.chatId
    const position = page.positions[index]
    if (!id || knownIds.has(id) || seen.has(id)) throw new Error("Reverse page has duplicate message IDs")
    if (!Number.isSafeInteger(position) || position <= previous || position >= (window.nextBefore ?? Infinity)) {
      throw new Error("Reverse page positions are noncontiguous")
    }
    seen.add(id)
    previous = position
  }
  if (page.hasMore ? page.nextBefore !== page.positions[0] : page.nextBefore !== null) {
    throw new Error("Reverse page boundary is noncontiguous")
  }
  if (!page.hasMore && knownIds.size + seen.size !== page.total) {
    throw new Error("Reverse page terminal coverage is incomplete")
  }
}

export async function ensureCharacterHydrated(db: Database, characterIndex: number): Promise<character | null> {
  const summary = db.characters[characterIndex];
  if (!summary) return null;
  if ((summary as HydratableCharacter).detailsLoaded !== false) return summary;
  const storage = getNodeBootstrapStorage();
  if (!storage) return summary;

  const characterId = summary.chaId;
  const existing = characterHydrations.get(characterId);
  if (existing) return existing;

  const hydration = (async () => {
    try {
      const full = await storage.loadCharacterHydration(characterId);
      if (!full) return null;
      if ((full as CollapsedCharacter)._sqlCharacterBodyCollapsed) {
        if (typeof (storage as Partial<SqlBootstrapStorage>).repairCollapsedCharacter !== "function") throw new Error("SQL character repair is unavailable");
        const repaired = await storage.repairCollapsedCharacter(characterId);
        // `unavailable` means the server walked its whole bounded backup
        // candidate list and found nothing applicable — never re-read here,
        // since the row on disk is guaranteed unchanged (the server only
        // ever commits on a match). Distinguish the two reason codes so the
        // failure at least reads differently for whoever sees the alert.
        if (repaired.status === "unavailable") {
          const reason = repaired.reason;
          const message = reason === "decode-failed"
            ? language.sqlCharacterRepairUnavailableDecodeFailed
            : reason === "no-candidate"
            ? language.sqlCharacterRepairUnavailableNoCandidate
            : "SQL character repair could not recover this character (reason unknown)";
          throw new Error(message);
        }
        const reloaded = await storage.loadCharacterHydration(characterId);
        if (!reloaded || (reloaded as CollapsedCharacter)._sqlCharacterBodyCollapsed) throw new Error("SQL character repair did not restore the character body");
        return applyHydratedCharacter(db, characterId, reloaded);
      }
      return applyHydratedCharacter(db, characterId, full);
    } finally {
      characterHydrations.delete(characterId);
    }
  })();
  characterHydrations.set(characterId, hydration);
  return hydration;
}

function applyHydratedCharacter(db: Database, characterId: string, full: character): character | null {
      const currentIndex = db.characters.findIndex((value) => value?.chaId === characterId);
      if (currentIndex === -1 || (db.characters[currentIndex] as HydratableCharacter | undefined)?.detailsLoaded !== false) return null;
      const normalized = normalizeHydratedCharacter(full);
      db.characters[currentIndex] = normalized;
      return normalized;
}

async function ensureChatBodyHydrated(
  character: character,
  chatIndex: number,
  carriedMetadata: Record<string, unknown> = {},
): Promise<Chat | null> {
  const summary = character.chats[chatIndex];
  if (!summary) return null;
  if ((summary as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded !== false) return summary;
  const storage = getNodeBootstrapStorage();
  if (!storage || typeof (storage as Partial<SqlBootstrapStorage>).loadChatHydration !== "function") return summary;
  const chatId = summary.id;
  if (!chatId) return null;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatBodyHydrations.get(key);
  if (existing) return existing;
  const initialMetadata = metadataSnapshot(summary);

  const hydration = (async () => {
    try {
      const response = await storage.loadChatHydration(chatId);
      if (!response) return null;
      const full = response.chat;
      if ((full as Chat & { characterId?: unknown }).characterId !== character.chaId) throw new Error("SQL chat hydration owner mismatch");
      const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current || (current as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded !== false) return null;
      const summaryMetadata = Object.fromEntries(
        CHAT_METADATA_KEYS.flatMap((key) =>
          Object.prototype.hasOwnProperty.call(carriedMetadata, key)
            ? [[key, carriedMetadata[key]]]
            : Object.prototype.hasOwnProperty.call(current, key) && !Object.is((current as unknown as Record<string, unknown>)[key], initialMetadata[key])
            ? [[key, (current as unknown as Record<string, unknown>)[key]]]
            : [],
        ),
      );
      const merged = { ...full, ...summaryMetadata, message: current.message ?? full.message ?? [] } as Chat;
      Object.defineProperty(merged, "_sqlHydrationRevision", { configurable: true, enumerable: false, value: response.revision });
      Object.defineProperty(merged, "_sqlMetadataOverrides", { configurable: true, enumerable: false, value: { ...carriedMetadata, ...summaryMetadata } });
      (merged as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded = true;
      character.chats[currentIndex] = merged;
      return merged;
    } finally {
      chatBodyHydrations.delete(key);
    }
  })();
  chatBodyHydrations.set(key, hydration);
  return hydration;
}

/** Hydrate a chat body before attaching its newest bounded message page. */
export async function ensureChatHydrated(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  return await ensureChatMessageWindow(character, chatIndex, limit);
}

export async function ensureChatMessageWindow(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  let initial = await ensureChatBodyHydrated(character, chatIndex);
  if (!initial) return null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return initial;
  const chatId = initial.id;
  if (!chatId) return null;
  const existingWindow = getWindow(initial);
  if (existingWindow) return initial;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      let page;
      for (let attempt = 0; attempt < MAX_CHAT_HYDRATION_ATTEMPTS; attempt += 1) {
        const pageMetadata = metadataSnapshot(initial);
        page = await storage.loadChatMessageReversePage(chatId, undefined, normalizeLimit(limit));
        if (page.revision === (initial as RevisionedChat)._sqlHydrationRevision) break;
        if (attempt + 1 === MAX_CHAT_HYDRATION_ATTEMPTS) throw new Error("SQL chat hydration revision changed");
        const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
        const current = currentIndex === -1 ? null : character.chats[currentIndex];
        if (!current) return null;
        (current as HydratableChat & { detailsLoaded?: boolean }).detailsLoaded = false;
        initial = await ensureChatBodyHydrated(character, currentIndex, { ...(current as RevisionedChat)._sqlMetadataOverrides, ...metadataChanges(current, pageMetadata) });
        if (!initial) return null;
      }
      if (!page) return null;
      const currentIndex = character.chats.findIndex((chat) => chat?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;
      attachCanonicalPositions(page.messages, page.positions);
      current.message = page.messages;
      current._placeholder = false;
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        nextPosition: page.nextPosition,
      });
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      endHydration(key);
      chatHydrations.delete(key);
    }
  })();
  chatHydrations.set(key, hydration);
  return hydration;
}

export async function loadOlderChatMessages(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const chat = character.chats[chatIndex];
  const window = chat && getWindow(chat);
  if (!chat || !window || !window.hasOlder || window.nextBefore === null) return chat ?? null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return chat;
  const chatId = chat.id;
  const key = chatHydrationKey(character.chaId, chatId);
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      const page = await storage.loadChatMessageReversePage(chatId, window.nextBefore ?? undefined, normalizeLimit(limit));
      const currentIndex = character.chats.findIndex((value) => value?.id === chatId);
      const current = currentIndex === -1 ? null : character.chats[currentIndex];
      if (!current) return null;
      const known = new Set(current.message.map((message) => message.chatId));
      // Use the common ID/total guard at the merge boundary; persisted SQL
      // boundaries and positions are validated below by this backend contract.
      validateOlderMessagePage(
        { offset: 0, total: page.total, messages: page.messages },
        { offset: page.messages.length, total: window.total, ids: [...known].filter((id): id is string => !!id) },
      );
      validateOlderReversePage(page, window, known);
      const olderPairs = page.messages.flatMap((message, index) =>
        !known.has(message.chatId) ? [{ message, position: page.positions?.[index] }] : [],
      );
      const older = olderPairs.map(({ message }) => message);
      if (older.length === 0 && page.hasMore && page.nextBefore === window.nextBefore) {
        setWindow(current, { ...window, hasOlder: false });
        return current;
      }
      attachCanonicalPositions(older, olderPairs.map(({ position }) => position));
      current.message = [...older, ...current.message];
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
        nextPosition: Math.max(window.nextPosition, page.nextPosition),
      });
      beginHydrationApply(key);
      await tick();
      endHydrationApply(key);
      return current;
    } finally {
      endHydration(key);
      chatHydrations.delete(key);
    }
  })();
  chatHydrations.set(key, hydration);
  return hydration;
}
