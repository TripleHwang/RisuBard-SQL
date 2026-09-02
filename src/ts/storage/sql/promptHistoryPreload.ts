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
 * A MESSAGE COUNT, derived from what the prompt's consumers actually read, with
 * the token budget kept only as a ceiling.
 *
 * This module used to stop when the resident history was worth the whole
 * request budget (`maxContext`), on the reasoning that the prompt's only cap on
 * history is `while (currentTokens > maxContextTokens) chats.splice(0, 1)`.
 * That reasoning was wrong, and it was wrong in the direction that costs
 * memory. Before any tokenisation happens, `process/index.svelte.ts` narrows
 * the history to `risuBardResponseMessageCount` messages
 * (`selectNarrativeWorkingMessages`), and THAT narrowed array is the only thing
 * the `chats` loop, the splice loop and `hypaMemoryV3` ever see. Twelve, by
 * default. A measured 1200-message chat was ending at 740 resident -- 2.3x
 * `MAX_RESIDENT_MESSAGES` -- and re-tokenising ~672 of them on every send, to
 * build a prompt that used twelve.
 *
 * `targetMessages` is that derived figure; see `process/promptHistoryBound.ts`
 * for each term and why. It is floored at the page a chat opens on, so no
 * consumer that cannot be bounded statically -- a trigger script indexing an
 * arbitrary message, `{{history}}` inside a lorebook entry -- ever sees a
 * window shorter than the one it saw before this module existed. It is capped
 * at `MAX_RESIDENT_MESSAGES`, which is the whole point: the memory bound is no
 * longer suspended for any chat that gets sent in.
 *
 * `targetMessages` counts array SLOTS, and the prompt does not read slots -- it
 * skips `disabled === true`. The bound cannot tell how many of each a chat has
 * (it runs before the first page request), so it guesses, and
 * `targetEnabledMessages` is what the guess was guessing at. This walk can see
 * the messages, so it checks: a chat with two of every three recent messages
 * disabled keeps paging past `targetMessages` until enough VISIBLE messages are
 * resident, stopping at `residentCeiling`. Without that second figure a reader
 * with a sixty-message working set got forty-three of them, silently.
 *
 * `budgetTokens` remains, as a CEILING and never as a target. The walk stops at
 * whichever comes first, so this can never load more history than the previous
 * behaviour would have, and a caller that passes no `targetMessages` gets
 * exactly the previous behaviour. The budget is an OVER-estimate of what the
 * history may occupy -- `maxContextTokens` is the budget for the WHOLE request,
 * and the history is only one of its parts -- so as a ceiling it is never the
 * thing that makes a load short.
 *
 * Loading "everything" instead of either would defeat the windowing this whole
 * subsystem exists for: a 20,000-message chat would be pulled entirely into
 * memory to send twelve messages of it.
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
   * Token budget the prompt may spend in total. A CEILING, not a target: the
   * load stops once the resident history is worth this much on its own, so it
   * can never load more than the pre-bound behaviour did.
   */
  budgetTokens: number;
  /**
   * Resident messages the prompt's consumers can actually reach, from
   * `resolvePromptHistoryBound`. The walk stops as soon as this many are
   * resident, which at default settings is before it starts.
   *
   * `undefined` means "could not be bounded" -- a lorebook entry whose
   * `@@scan_depth` does not parse scans the entire resident array -- and falls
   * back to `budgetTokens` alone, which is the behaviour every send had before
   * this option existed. Under-estimating here is the dangerous direction: it
   * builds a prompt from a history shorter than it should be, and nothing
   * downstream notices. Callers pass a figure with headroom.
   */
  targetMessages?: number;
  /**
   * Messages the prompt can SEE (`disabled === true` skipped) that must be
   * resident, from `resolvePromptHistoryBound`.
   *
   * `targetMessages` is a guess at how many array slots that takes, made
   * without reading the messages. This is the thing the guess was guessing at,
   * and the walk can read the messages, so it checks: a chat whose recent
   * history is mostly disabled keeps paging past `targetMessages` until this
   * many visible messages are resident, or until `residentCeiling` stops it.
   * Without this check a reader who asked for a 60-message working set and
   * disabled two of every three recent messages got 43 of them, silently.
   */
  targetEnabledMessages?: number;
  /**
   * Hard stop on the walk, normally `MAX_RESIDENT_MESSAGES`. Only
   * `targetEnabledMessages` can push the load past `targetMessages`, and this
   * is what keeps that from pushing it past the residency bound. Ignored when
   * there is no `targetEnabledMessages` to extend the walk.
   */
  residentCeiling?: number;
  /**
   * Load the WHOLE conversation: page back until `hasOlder` is false, and stop
   * for nothing else.
   *
   * Everything above bounds the walk to what a PROMPT can read, and that is the
   * right bound for a send: the prompt narrows to a working set of a dozen
   * messages, so loading a 20,000-message chat to send twelve of them would
   * defeat the windowing this subsystem exists for.
   *
   * A BardWiki reboot is not a send. It rebuilds the wiki from a chosen point
   * in the conversation forward, one turn at a time, and it indexes
   * `chat.message` FROM THE FRONT to find that point
   * (`projectWikiRebootTurns(chat.message, startChatIndex)`). Every one of the
   * bounds above would hand it a slice of the newest end, and it would index
   * into that slice and rebuild the wiki from the wrong messages -- silently,
   * because a short resident array looks exactly like a short conversation. Its
   * requirement is the whole history, and nothing less is usable.
   *
   * So this mode turns off all three of the prompt-shaped stops:
   *
   *   - `targetMessages` / `targetEnabledMessages` / `residentCeiling` are
   *     ignored. The residency bound (`MAX_RESIDENT_MESSAGES`) is not a bound
   *     this load can honour -- a conversation longer than it must exceed it to
   *     be whole -- so the caller MUST hold a residency pin for as long as it
   *     needs the history, which is what stops the next page load from trimming
   *     the newest end back off. This function pins for its own duration; a
   *     caller that reads the history after it returns pins around the whole
   *     operation (see `wikiRebootLifecycle.ts`);
   *   - `budgetTokens` is ignored, and with it the tokenizer pass that answers
   *     it. Nothing is measured that nothing reads;
   *   - a resident `disabled === 'allBefore'` marker no longer ends the walk.
   *     That marker means "the PROMPT reads nothing older"; the reboot's
   *     projection has no such rule and rebuilds across it, so stopping there
   *     would be a short load by a rule that does not apply.
   *
   * The walk therefore ends only at the true start of the conversation, and the
   * result's `reachedStartOfHistory` is the caller's proof that it did.
   */
  loadEntireHistory?: boolean;
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
   * True when nothing older can still change the prompt: the start of the
   * conversation is resident, or enough messages for every consumer are, or
   * the resident history is already worth more than the whole request budget.
   */
  historySatisfied: boolean;
  /**
   * The message target this run was given, echoed back so a caller can report
   * what bounded the load. `undefined` when only the budget did.
   */
  targetMessages: number | undefined;
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
  // "The whole conversation" is not a bound to be balanced against the others;
  // it replaces them. Dropping the targets here rather than special-casing each
  // stop below means there is one place where the mode changes what the walk
  // does, and the stop tests keep reading exactly one set of numbers.
  const loadEntireHistory = options.loadEntireHistory === true;
  // A target that is not a usable count is no target: fall back to the budget
  // rather than invent one. `undefined` here and `Infinity` behave identically
  // and both mean "the budget is the only stop", which is the old behaviour.
  const targetMessages = loadEntireHistory
    ? undefined
    : typeof options.targetMessages === "number" && Number.isFinite(options.targetMessages)
      ? Math.max(1, Math.floor(options.targetMessages))
      : undefined;
  // Only meaningful alongside a raw target: on its own it would extend a walk
  // that has no bound to extend from.
  const targetEnabledMessages =
    targetMessages !== undefined
      && typeof options.targetEnabledMessages === "number"
      && Number.isFinite(options.targetEnabledMessages)
      ? Math.max(1, Math.floor(options.targetEnabledMessages))
      : undefined;
  const residentCeiling =
    typeof options.residentCeiling === "number" && Number.isFinite(options.residentCeiling)
      ? Math.max(targetMessages ?? 1, Math.floor(options.residentCeiling))
      : (targetMessages ?? Number.POSITIVE_INFINITY);

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
      targetMessages,
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

    // ── 2. Walk backwards until every consumer's reach is resident ──────────
    //
    // Three stops, whichever comes first:
    //
    //  - `targetMessages` resident AND `targetEnabledMessages` of them visible
    //    to the prompt. The derived bound; normally the one that fires, and
    //    normally before the first request. The second half is what a chat with
    //    a heavily disabled recent history needs: `targetMessages` was computed
    //    without reading the messages, so on such a chat it is optimistic, and
    //    the walk keeps going -- to `residentCeiling` and no further.
    //  - a `disabled === 'allBefore'` marker resident. `makeMs` stops there, so
    //    nothing older is reachable by the prompt at any depth.
    //  - the resident history worth the whole request budget. The ceiling,
    //    kept so this can never load more than it used to.
    //
    // The token measure is lazy and runs at most once, and the message-count
    // test is checked first precisely so that at default settings it never runs
    // at all. A chat that already holds the start of its history
    // (`hasOlder === false`) is satisfied whatever it costs, and tokenizing it
    // to find that out would put a full extra tokenizer pass on every send of
    // every short conversation.
    let measuredTokens = 0;
    let measured = false;
    const residentCount = () => live()?.message?.length ?? 0;
    const enabledResidentCount = () => promptVisible(live()?.message ?? []).length;
    /**
     * Resident messages still missing before the count test can pass, or 0 when
     * it already does. The enabled leg is what can exceed the raw target, and
     * the ceiling is what stops it running away on a chat that is mostly
     * disabled.
     */
    const stillMissing = () => {
      if (targetMessages === undefined) return Number.POSITIVE_INFINITY;
      const resident = residentCount();
      let missing = targetMessages - resident;
      if (targetEnabledMessages !== undefined) {
        missing = Math.max(missing, targetEnabledMessages - enabledResidentCount());
      }
      return Math.max(0, Math.min(missing, residentCeiling - resident));
    };
    /**
     * Size of the next page.
     *
     * `stillMissing` counts what is missing; on the enabled leg it counts
     * VISIBLE messages, and asking for that many array slots on a chat that is
     * two-thirds disabled fills a third of the gap and asks again. Measured
     * that way: ten round trips to reach sixty visible messages. Scaling the
     * request by the visible density already observed turns the same walk into
     * a handful. It is a page-size estimate and nothing else -- `stillMissing`
     * remains the stop test, so a wrong estimate costs a request, never a
     * short load.
     */
    const nextPageSize = () => {
      const missing = stillMissing();
      if (targetMessages === undefined || missing <= 0) return pageSize;
      const resident = residentCount();
      const headroom = Math.max(1, residentCeiling - resident);
      const enabledMissing = targetEnabledMessages === undefined
        ? 0
        : targetEnabledMessages - enabledResidentCount();
      let wanted = missing;
      if (enabledMissing > 0 && resident > 0) {
        // Never below 1/resident, so a slice with nothing visible in it still
        // asks for a whole page rather than dividing by zero.
        const density = Math.max(enabledResidentCount(), 1) / resident;
        wanted = Math.max(wanted, Math.ceil(enabledMissing / density));
      }
      return Math.max(1, Math.min(pageSize, headroom, wanted));
    };
    const satisfied = async () => {
      // Nothing short of the start of the conversation satisfies a whole-history
      // load, so none of the three stops below is consulted -- including the
      // token measure, which would otherwise tokenize the entire resident
      // history to answer a question this mode never asks.
      if (loadEntireHistory) return false;
      if (targetMessages !== undefined && stillMissing() <= 0) return true;
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

      // Ask for what is still missing, never for a round hundred past it. The
      // stop test fires between pages, so a full-size final page would leave
      // the chat holding up to `pageSize - 1` messages that no consumer reads
      // -- and on a target set at `MAX_RESIDENT_MESSAGES` that overshoot is
      // exactly what would put the resident slice back over the bound this
      // whole change exists to restore.
      const wanted = nextPageSize();

      requests += 1;
      // Rejections propagate untouched: `loadOlderChatMessages` throws with the
      // contiguity/identity reason, which is what a report needs to be useful.
      await loadOlderChatMessages(character, chatIndex, wanted);

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
      targetMessages,
    };
  } finally {
    endResidencyPin(chatId);
  }
}
