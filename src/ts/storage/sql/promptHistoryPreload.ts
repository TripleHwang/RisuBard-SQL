import type { Chat, Message, character } from "../database.svelte";
import { getSqlWindow } from "./sqlRuntimeWindow";
import { beginResidencyPin, endResidencyPin } from "./residencyPin";
import { loadNewestChatMessages, loadOlderChatMessages } from "./sqlRuntimeHydration";

/**
 * Make a chat's resident history long enough that generation can build its
 * prompt from it.
 *
 * WHY THIS EXISTS
 *
 * A chat opens on its newest 40 messages (`hydrateRecentChatPage`), so every
 * conversation longer than 40 messages opens with `hasOlder === true`. The
 * prompt is built from `chat.message` -- the resident slice -- so generating
 * from that state would send 40 messages of context for a conversation that
 * should have sent hundreds, with nothing on screen to say so. `sendChat`
 * refused outright rather than do that, and told the reader to "load earlier
 * messages before generating": a state the application can resolve on its own,
 * pushed onto the user as manual scrolling through a history that may be
 * thousands of messages long.
 *
 * This is the resolution. Page older messages in until the prompt's history
 * budget is satisfied or the true start of the conversation is reached, then
 * let the send proceed. Neither the block nor the silent truncation happens.
 *
 * WHAT BOUNDS THE LOAD
 *
 * The prompt's history bound is a TOKEN budget, not a message count. Every
 * enabled message in `chat.message` is turned into an `OpenAIChat` and pushed
 * onto `chats` (process/index.svelte.ts), and what shortens that list is
 * `while (currentTokens > maxContextTokens) chats.splice(0, 1)` -- dropping
 * from the OLDEST end. When memory summarization is on, `hypaMemoryV3` takes
 * the same array and the same `maxContextTokens` and summarizes the overflow
 * instead of dropping it. There is no maximum message count anywhere in that
 * path.
 *
 * So the load stops as soon as the resident history is worth at least
 * `budgetTokens` on its own. Past that point every additional older message is
 * provably discarded (or summarized, which the persisted `hypaV3Data` already
 * covers) before the request is built, so fetching it would be pure cost.
 * Loading "everything" instead would defeat the windowing this whole subsystem
 * exists for: a 20,000-message chat would be pulled entirely into memory to
 * send 65,000 tokens of it.
 *
 * The budget is deliberately an OVER-estimate of what the history may occupy:
 * `maxContextTokens` is the budget for the WHOLE request, and the history is
 * only one of its parts (description, lorebook, persona, author's note, memory
 * and the example messages all come out of the same budget). Measuring the
 * history against the whole budget therefore loads at least as much as the
 * prompt can use, never less.
 *
 * WHAT IS NOT NEGOTIABLE
 *
 *  - `hasNewer` must be false when this returns. A window whose newest end was
 *    released by residency trimming does not end where the history does, and a
 *    reply appended to it would be appended after a hole. `loadNewestChatMessages`
 *    is the return path and it is taken automatically; if it fails, this
 *    rejects and the send must refuse.
 *  - a page that fails to load rejects. There is no path from "could not read
 *    the history" to "send what we have". The caller turns the rejection into a
 *    refusal that says the load failed -- not into advice to do something the
 *    reader cannot do.
 *  - the newest end is pinned for the duration (`residencyPin.ts`). Paging a
 *    long history back crosses `MAX_RESIDENT_MESSAGES` routinely, and the trim
 *    that fires when it does releases from the NEWEST end -- the tail the send
 *    is about to append to. See the module comment there.
 */

/** How far a preload has got, for progress display. */
export interface PromptHistoryPreloadProgress {
  /** What the loader is doing: restoring a trimmed tail, or walking backwards. */
  phase: "restoring-newest" | "loading-older";
  /** Messages resident right now. */
  resident: number;
  /** Messages the chat has in storage, as of the last page. */
  total: number;
  /** Page requests issued so far. */
  requests: number;
}

export interface PromptHistoryPreloadOptions {
  character: character;
  chatIndex: number;
  /**
   * Token budget the prompt may spend in total. The load stops once the
   * resident history is worth this much on its own.
   */
  budgetTokens: number;
  /**
   * Token cost of a run of messages, measured the way the prompt measures them.
   * Called with newly arrived messages only, so the walk stays O(history).
   *
   * Under-counting is safe and over-counting is not: an under-count loads more
   * history than the prompt can use, an over-count stops short of what it can.
   * Callers pass the real tokenizer over the raw message text, which is a
   * lower bound on what the prompt will charge for the same message once names
   * and formatting are added.
   */
  measure: (messages: Message[]) => Promise<number>;
  /** Messages per request. Storage caps this at 100. */
  pageSize?: number;
  /**
   * Called before the first request and after every page. Paging back through
   * a long history is several round trips; a silent multi-second pause on
   * pressing send is its own defect.
   */
  onProgress?: (progress: PromptHistoryPreloadProgress) => void;
  signal?: AbortSignal;
}

export interface PromptHistoryPreloadResult {
  /**
   * True when the resident slice ends where the persisted history does.
   * ALWAYS true on a resolved result -- a run that could not restore the
   * newest end rejects rather than returning `false` here.
   */
  holdsNewestEnd: boolean;
  /**
   * True when nothing older can still change the prompt: either the start of
   * the conversation is resident, or the resident history is already worth
   * more than the whole request budget.
   */
  historySatisfied: boolean;
  /** True when `chat.message` starts at the first message of the conversation. */
  reachedStartOfHistory: boolean;
  /** Resident message count when this returned. */
  resident: number;
  /** Persisted message count, as of the last page seen. */
  total: number;
  /** Page requests issued. Zero when nothing had to be loaded. */
  requests: number;
  /** Measured token cost of the resident history. */
  measuredTokens: number;
}

const DEFAULT_PAGE_SIZE = 100;
/**
 * Refuse to walk further than this many pages in one preload.
 *
 * A bound, not a budget: at 100 messages a page this is 20,000 messages, well
 * past any real conversation, and every ordinary stop (`hasOlder === false`, the
 * token budget) fires long before it. It exists so that a backend that keeps
 * answering `hasMore` without ever moving `nextBefore` cannot spin forever
 * behind a progress dialog. Crossing it throws; it is never a quiet stop,
 * because a quiet stop here is a short prompt.
 */
const MAX_PRELOAD_REQUESTS = 200;

function throwIfAborted(signal: AbortSignal | undefined, chatId: string): void {
  if (signal?.aborted) {
    throw new Error(`Loading the history of chat ${chatId} for the prompt was cancelled.`);
  }
}

/**
 * A message that ends the prompt's interest in anything older.
 *
 * `makeMs` in the prompt builder walks the resident array backwards and STOPS
 * at the first `disabled === 'allBefore'`, so the history the prompt uses
 * starts there. Once one is resident, nothing older is reachable by the prompt
 * and paging further back would be loading messages that are discarded before
 * they are ever tokenized.
 */
function residentHistoryIsCutOff(messages: readonly Message[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message?.disabled === "allBefore") return true;
  }
  return false;
}

/** Enabled messages only -- the prompt skips `disabled === true` outright. */
function promptVisible(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message?.disabled !== true);
}

/**
 * Token cost of `messages`, measured from the NEWEST end backwards and
 * abandoned as soon as `budget` is reached.
 *
 * The question this answers is a boolean -- "is the resident history already
 * worth the whole request budget?" -- and the early exit is what keeps asking
 * it cheap. Without it, every send on a chat that has already been paged deep
 * would re-tokenize its entire resident history just to re-derive an answer
 * that the first chunk settles.
 *
 * Newest-first is the right direction because the prompt drops from the OLDEST
 * end: the newest messages are the ones certain to be in the request, so they
 * are the ones whose cost counts first. The returned number is therefore a
 * lower bound on the true total once it has reached the budget, which is all
 * any caller here compares it against.
 */
async function measureAtLeast(
  messages: readonly Message[],
  budget: number,
  measure: (messages: Message[]) => Promise<number>,
  chunkSize = 32,
): Promise<number> {
  let total = 0;
  for (let end = messages.length; end > 0 && total < budget; end -= chunkSize) {
    total += await measure(messages.slice(Math.max(0, end - chunkSize), end));
  }
  return total;
}

export async function ensurePromptHistoryResident(
  options: PromptHistoryPreloadOptions,
): Promise<PromptHistoryPreloadResult> {
  const { character, chatIndex, budgetTokens, measure, onProgress, signal } = options;
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));

  const chat = character?.chats?.[chatIndex] as Chat | undefined;
  if (!chat) {
    throw new Error(`Cannot load prompt history: chat ${chatIndex} is not present.`);
  }
  const chatId = chat.id;

  // No window at all means this chat is not a view of a SQL page: it was never
  // hydrated from one, or the backend is not the SQL one. `chat.message` is
  // then the whole history by construction and there is nothing to page in.
  // Absence of a window is absence of evidence of MORE, which is exactly the
  // reading `hasOlderSqlMessages` takes.
  if (!getSqlWindow(chat)) {
    const resident = chat.message?.length ?? 0;
    return {
      holdsNewestEnd: true,
      historySatisfied: true,
      reachedStartOfHistory: true,
      resident,
      total: resident,
      requests: 0,
      measuredTokens: 0,
    };
  }

  // Pinned for the whole walk, including the `loadNewestChatMessages` leg. The
  // caller (a send) is normally inside a generation, which pins too; the counts
  // nest, so this one is correct on its own for a caller that is not.
  beginResidencyPin(chatId);
  try {
    let requests = 0;
    let window = getSqlWindow(chat)!;

    // ── 1. Restore the newest end, if residency trimming released it ────────
    //
    // Nothing about this needs the user. `loadNewestChatMessages` refuses to
    // release a dirty or unpositioned message rather than lose it, so a failure
    // here is a real refusal and is passed on as one.
    if (window.hasNewer) {
      onProgress?.({
        phase: "restoring-newest",
        resident: chat.message?.length ?? 0,
        total: window.total,
        requests,
      });
      throwIfAborted(signal, chatId ?? "(no id)");
      requests += 1;
      await loadNewestChatMessages(character, chatIndex, pageSize);
      const restored = character.chats?.[chatIndex] as Chat | undefined;
      const restoredWindow = restored && getSqlWindow(restored);
      if (!restored || !restoredWindow || restoredWindow.hasNewer) {
        throw new Error(
          `Could not restore the newest messages of chat ${chatId ?? "(no id)"} before generating; ` +
          "the resident history still does not end where the conversation does.",
        );
      }
      window = restoredWindow;
    }

    // Re-read the slot: `loadNewestChatMessages` may have replaced or moved it.
    const live = () => character.chats?.[chatIndex] as Chat | undefined;

    // ── 2. Walk backwards until the prompt's budget is covered ──────────────
    //
    // Measured lazily and only once. A chat that already holds the start of its
    // history (`hasOlder === false`) is satisfied whatever it costs, and
    // tokenizing it to find that out would put a full extra tokenizer pass on
    // every send of every short conversation.
    let measuredTokens = 0;
    let measured = false;
    const satisfied = async () => {
      if (residentHistoryIsCutOff(live()?.message)) return true;
      if (!measured) {
        measuredTokens = await measureAtLeast(
          promptVisible(live()?.message ?? []),
          budgetTokens,
          measure,
        );
        measured = true;
      }
      return measuredTokens >= budgetTokens;
    };

    while (window.hasOlder && !(await satisfied())) {
      throwIfAborted(signal, chatId ?? "(no id)");
      if (requests >= MAX_PRELOAD_REQUESTS) {
        throw new Error(
          `Loading the history of chat ${chatId ?? "(no id)"} for the prompt did not terminate ` +
          `after ${requests} requests; refusing to generate from a history that may be short.`,
        );
      }
      const before = live();
      const knownIds = new Set((before?.message ?? []).map((message) => message.chatId));
      const beforeCount = before?.message?.length ?? 0;

      onProgress?.({
        phase: "loading-older",
        resident: beforeCount,
        total: window.total,
        requests,
      });

      requests += 1;
      // Rejections propagate untouched: `loadOlderChatMessages` throws with the
      // contiguity/identity reason, which is what a report needs to be useful.
      await loadOlderChatMessages(character, chatIndex, pageSize);

      const after = live();
      const nextWindow = after && getSqlWindow(after);
      if (!after || !nextWindow) {
        throw new Error(
          `Chat ${chatId ?? "(no id)"} lost its hydration window while its history was being ` +
          "loaded for the prompt; refusing to generate from what is left.",
        );
      }
      // The trim is pinned off for this walk, so a released newest end here
      // would mean the pin failed. Checked rather than assumed: this is the
      // exact failure the pin exists to prevent, and it must not pass silently.
      if (nextWindow.hasNewer) {
        throw new Error(
          `Loading the history of chat ${chatId ?? "(no id)"} released its newest messages; ` +
          "refusing to generate from a history with a hole at the end.",
        );
      }

      const arrived = (after.message ?? []).filter((message) => !knownIds.has(message.chatId));
      measuredTokens += await measure(promptVisible(arrived));

      // No progress and storage still claims more: another page would ask the
      // same question and get the same answer. `loadOlderChatMessages` already
      // clears `hasOlder` for the benign version of this (a page that returns
      // only messages we hold), so reaching here with `hasOlder` still set and
      // the boundary unmoved is a backend that is not advancing.
      if (arrived.length === 0 && nextWindow.hasOlder && nextWindow.nextBefore === window.nextBefore) {
        throw new Error(
          `Storage returned no older messages for chat ${chatId ?? "(no id)"} while still ` +
          "reporting more before them; refusing to generate from a partial history.",
        );
      }
      window = nextWindow;
    }

    const finalChat = live();
    const finalWindow = finalChat && getSqlWindow(finalChat);
    if (!finalChat || !finalWindow || finalWindow.hasNewer) {
      throw new Error(
        `Chat ${chatId ?? "(no id)"} does not hold the newest end of its history after loading; ` +
        "refusing to generate.",
      );
    }
    const resident = finalChat.message?.length ?? 0;
    // Only when a progress display was actually warranted. A run of one request
    // never raised one (see the `requests < 1` rule callers apply), and a
    // closing update for a dialog nobody saw is a flash on an otherwise
    // instant send.
    if (requests > 1) {
      onProgress?.({ phase: "loading-older", resident, total: finalWindow.total, requests });
    }
    return {
      holdsNewestEnd: true,
      historySatisfied: !finalWindow.hasOlder || (await satisfied()),
      reachedStartOfHistory: !finalWindow.hasOlder,
      resident,
      total: finalWindow.total,
      requests,
      measuredTokens,
    };
  } finally {
    endResidencyPin(chatId);
  }
}
