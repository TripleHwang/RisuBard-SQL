const inFlight = new Map<string, number>();
const justApplied = new Map<string, number>();

export function beginHydration(key: string): void {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
}

export function endHydration(key: string): void {
  const remaining = (inFlight.get(key) ?? 1) - 1;
  if (remaining > 0) inFlight.set(key, remaining);
  else inFlight.delete(key);
}

export function beginHydrationApply(key: string): void {
  justApplied.set(key, (justApplied.get(key) ?? 0) + 1);
}

export function endHydrationApply(key: string): void {
  const remaining = (justApplied.get(key) ?? 1) - 1;
  if (remaining > 0) justApplied.set(key, remaining);
  else justApplied.delete(key);
}

export function isHydrationActive(key: string): boolean {
  return inFlight.has(key) || justApplied.has(key);
}

/** Message mutation APIs carry a chat id, while hydration owns character/chat keys. */
export function isChatHydrationActive(chatId: string): boolean {
  return [...inFlight.keys(), ...justApplied.keys()].some(key => isChatHydrationKeyFor(key, chatId));
}
import { isChatHydrationKeyFor } from './chatHydrationKey';
