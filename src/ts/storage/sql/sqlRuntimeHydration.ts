import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";
import { validateOlderMessagePage } from "../../chatWindow";

export type SqlHydrationWindow = {
  before: number | null;
  nextBefore: number | null;
  total: number;
  hasOlder: boolean;
  nextPosition: number;
};
type HydratableCharacter = character & { detailsLoaded?: boolean };
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
const characterHydrations = new Map<string, Promise<character | null>>();
const chatHydrations = new Map<string, Promise<Chat | null>>();

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
  Object.defineProperty(chat, "_sqlWindow", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: window,
  });
}

function getWindow(chat: Chat): SqlHydrationWindow | undefined {
  return (chat as Chat & { _sqlWindow?: SqlHydrationWindow })._sqlWindow;
}

function attachCanonicalPositions(messages: Chat["message"], positions: number[] | undefined): void {
  if (!positions || positions.length !== messages.length) return;
  for (const [index, message] of messages.entries()) {
    Object.defineProperty(message, "_sqlPosition", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: positions[index],
    });
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
  if (page.hasMore ? page.nextBefore === null || page.nextBefore >= page.before! : page.nextBefore !== null) {
    throw new Error("Reverse page boundary is noncontiguous")
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
      const currentIndex = db.characters.findIndex((value) => value?.chaId === characterId);
      if (currentIndex === -1 || (db.characters[currentIndex] as HydratableCharacter | undefined)?.detailsLoaded !== false) return null;
      const normalized = normalizeHydratedCharacter(full);
      db.characters[currentIndex] = normalized;
      return normalized;
    } finally {
      characterHydrations.delete(characterId);
    }
  })();
  characterHydrations.set(characterId, hydration);
  return hydration;
}

export async function ensureChatMessageWindow(character: character, chatIndex: number, limit?: number): Promise<Chat | null> {
  const initial = character.chats[chatIndex];
  if (!initial) return null;
  const storage = getNodeBootstrapStorage();
  if (!storage) return initial;
  const chatId = initial.id;
  if (!chatId) return null;
  const existingWindow = getWindow(initial);
  if (existingWindow) return initial;
  const key = `${character.chaId}/${chatId}`;
  const existing = chatHydrations.get(key);
  if (existing) return existing;

  const hydration = (async () => {
    beginHydration(key);
    try {
      const page = await storage.loadChatMessageReversePage(chatId, undefined, normalizeLimit(limit));
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
  const key = `${character.chaId}/${chatId}`;
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
