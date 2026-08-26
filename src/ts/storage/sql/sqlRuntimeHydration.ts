import type { Chat, Database, character } from "../database.svelte";
import type { SqlBootstrapStorage } from "./ISqlStorage";
import { getActiveSqlStorage } from "./sqlBootstrap";
import { tick } from "svelte";
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from "../hydrationState";

export type SqlHydrationWindow = {
  before: number | null;
  nextBefore: number | null;
  total: number;
  hasOlder: boolean;
};
type HydratableCharacter = character & { detailsLoaded?: boolean };
type HydratableChat = Chat & { messagesLoaded?: boolean; messagesFullyLoaded?: boolean };

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
      db.characters[currentIndex] = full;
      return full;
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
      current.message = page.messages;
      current._placeholder = false;
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
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
      const older = page.messages.filter((message) => !known.has(message.chatId));
      if (older.length === 0 && page.hasMore && page.nextBefore === window.nextBefore) {
        setWindow(current, { ...window, hasOlder: false });
        return current;
      }
      current.message = [...older, ...current.message];
      (current as HydratableChat).messagesLoaded = true;
      (current as HydratableChat).messagesFullyLoaded = !page.hasMore;
      setWindow(current, {
        before: page.before,
        nextBefore: page.nextBefore,
        total: page.total,
        hasOlder: page.hasMore,
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
