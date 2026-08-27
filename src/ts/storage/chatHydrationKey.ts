/** Collision-safe identity shared by chat hydration and dirty suppression. */
export function chatHydrationKey(characterId: string, chatId: string): string {
  return JSON.stringify([characterId, chatId]);
}

export function isChatHydrationKeyFor(key: string, chatId: string): boolean {
  try { const value = JSON.parse(key); return Array.isArray(value) && value.length === 2 && value[1] === chatId; }
  catch { return false; }
}
