/**
 * Chats whose newest resident end must not be released right now.
 *
 * Residency trimming (`releaseNewestResidentMessages` in
 * `sqlRuntimeHydration.ts`) releases messages from the NEWEST end of a resident
 * slice once it passes `MAX_RESIDENT_MESSAGES`. That direction is right for
 * scroll-driven paging -- the reader is at the oldest resident message, so the
 * newest end is the far end from where they are looking -- and wrong for
 * anything that is about to write at that end.
 *
 * Two things do exactly that:
 *
 *  - the prompt preload (`promptHistoryPreload.ts`) pages older messages in on
 *    purpose, so that generation builds its prompt from the history the budget
 *    asks for rather than from the 40 messages a chat opens on. A long history
 *    crosses the bound routinely, and the trim that fires when it does would
 *    release the tail the reply is about to be appended to -- the send would
 *    then be building a prompt over a hole it just made;
 *  - a generation in flight. From `startGeneration` to `endGeneration` the
 *    pipeline holds indices into `chat.message`, appends the user's turn and
 *    the streamed reply, and reads the tail back to attach `generationInfo`.
 *    A concurrent scroll-driven page load that trimmed underneath it would move
 *    those messages out from under it.
 *
 * A pin is a refusal to release, never a deletion and never a load: nothing
 * here touches a chat. When the last pin for a chat is dropped, the next page
 * load trims as it always did, so the bound is delayed, not abandoned.
 *
 * Counted rather than boolean. The preload and the generation that runs it
 * overlap by construction, and so do two overlapping sends in different code
 * paths; a boolean would let whichever finished first unpin the other.
 *
 * This module deliberately imports nothing. It sits below both
 * `sqlRuntimeHydration.ts` (storage) and `generationState.ts` (process) and is
 * the only edge between them, so pinning cannot introduce an import cycle
 * between the storage and process graphs.
 */

const pins = new Map<string, number>();

function normalize(chatId: string | null | undefined): string | null {
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

/**
 * Hold the newest end of one chat resident until the matching
 * {@link endResidencyPin}. Always pair them in a `finally`: a leaked pin stops
 * that chat from ever being trimmed again for the rest of the session, which
 * is a memory leak rather than a data loss, but is still not something to
 * leave behind.
 */
export function beginResidencyPin(chatId: string | null | undefined): void {
  const id = normalize(chatId);
  if (!id) return;
  pins.set(id, (pins.get(id) ?? 0) + 1);
}

/** Release one pin. Dropping to zero removes the entry entirely. */
export function endResidencyPin(chatId: string | null | undefined): void {
  const id = normalize(chatId);
  if (!id) return;
  const held = pins.get(id);
  if (held === undefined) return;
  if (held <= 1) pins.delete(id);
  else pins.set(id, held - 1);
}

/** True while at least one holder is depending on this chat's newest end. */
export function isResidencyPinned(chatId: string | null | undefined): boolean {
  const id = normalize(chatId);
  return id !== null && (pins.get(id) ?? 0) > 0;
}

/** Diagnostics and tests only. */
export function getResidencyPinCount(chatId: string | null | undefined): number {
  const id = normalize(chatId);
  return id === null ? 0 : pins.get(id) ?? 0;
}

/** Test-only reset; production code always unpins from a `finally`. */
export function resetResidencyPinsForTesting(): void {
  pins.clear();
}
