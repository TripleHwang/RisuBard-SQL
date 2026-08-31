import type { Chat, character } from "../storage/database.svelte"

/**
 * Which chat a prompt-history preload was run for, and whether the application
 * is still looking at it.
 *
 * `sendChat` used to resolve the selected character, check that its chat's
 * hydration window was whole, and read the chat the prompt is built from in one
 * synchronous block: the check and its subject could not disagree. Loading the
 * history instead of refusing puts several HTTP round trips in the middle of
 * that block, and the reader is free to switch chats while the pages are in the
 * air. Everything after the preload re-reads the selection out of `DBState`, so
 * without this the send would build its prompt from a chat that was never
 * preloaded -- one sitting on the newest 40 messages it opened with. That is
 * the silent truncation the guard exists to prevent, so a moved target is a
 * refusal.
 *
 * A leaf module with no imports beyond types: it is called from the middle of
 * `sendChat`, which cannot be executed under test, so the comparison itself
 * lives somewhere that can be.
 */
export interface PromptPreloadTarget {
  /** The character the preload ran under. */
  chaId: string | undefined
  /** The chat slot within that character. */
  chatPage: number
  /**
   * The chat's own id, when it has one. Legacy chats can reach `sendChat`
   * before one is assigned (`ensureNarrativeSessionChatId` runs later), so this
   * is evidence when present and simply absent when not -- never a reason to
   * refuse a send that has done nothing wrong.
   */
  chatId: string | undefined
}

export function capturePromptPreloadTarget(
  character: character | undefined,
  chatPage: number,
  chat: Chat | undefined,
): PromptPreloadTarget {
  return { chaId: character?.chaId, chatPage, chatId: chat?.id }
}

/**
 * True when the application is no longer looking at the chat the preload
 * loaded, so the history that was just made whole is not the history the
 * prompt would be built from.
 *
 * Both directions matter and both are cheap: the character can change (the
 * reader opened someone else) and the chat slot can change within one character
 * (they switched chat page). The chat id is compared as well, because a slot
 * index alone is reused when a chat is deleted out from under the selection.
 */
export function promptPreloadTargetMoved(
  target: PromptPreloadTarget,
  settled: character | undefined,
): boolean {
  if (!settled) return true
  if (settled.chaId !== target.chaId) return true
  if (settled.chatPage !== target.chatPage) return true
  // Only when the preload had an id to remember. Absent, the character and
  // slot comparison above is exactly what the code did before the preload
  // existed, so a chat with no id is no worse off than it used to be.
  if (target.chatId === undefined) return false
  return settled.chats?.[settled.chatPage]?.id !== target.chatId
}
