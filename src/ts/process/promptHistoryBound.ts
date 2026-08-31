import { CCardLib } from "@risuai/ccardlib";

import type { Chat, Database, character, loreBook } from "../storage/database.svelte";
import { normalizeNarrativeWorkingMessageLimit } from "../risubard/narrativeContext";
import { resolveRisuBardChatSettings } from "../risubard/risuBardSettings";
import { MAX_RESIDENT_MESSAGES, OPEN_PAGE_MESSAGES } from "../storage/sql/sqlRuntimeHydration";
import { isLorebookEntryEnabled } from "./lorebookActivation";

/**
 * How many resident messages a send actually needs.
 *
 * WHY THIS EXISTS
 *
 * `promptHistoryPreload.ts` pages older messages in before a send so the prompt
 * is not built from a chat's opening 40. Until now the walk stopped when the
 * resident history was worth the WHOLE request budget (`maxContext`, 65,000 on
 * a ModelPreset). That was chosen as a deliberate over-approximation because
 * nobody had audited what the prompt reads.
 *
 * The audit has been done, and the budget turns out not to be the bound at all.
 * The prompt's history is capped by a MESSAGE COUNT applied before any
 * tokenisation happens:
 *
 *     process/index.svelte.ts
 *       ms = makeMs(currentChat)                       // enabled messages
 *       ms = selectNarrativeWorkingMessages(ms, limit) // <- narrativeContext.ts:401
 *       for (const msg of ms) { ...build `chats`... }  // the only reader of ms
 *
 * `chats` is what `while (currentTokens > maxContextTokens) chats.splice(0,1)`
 * trims and what `hypaMemoryV3` summarises, and it can never hold more than
 * `limit` history messages -- twelve by default. Every message the walk loaded
 * past that was tokenised on every subsequent send and then discarded. A
 * measured 1200-message chat sat at 740 resident, 2.3x `MAX_RESIDENT_MESSAGES`,
 * to build a prompt that used twelve of them.
 *
 * So the target is derived from the consumers instead, and the token budget is
 * demoted to a CEILING: the walk still stops if the resident history is worth
 * the whole budget, it just almost never gets that far.
 *
 * TWO FIGURES, NOT ONE
 *
 * `targetEnabledMessages` is what the prompt must be able to SEE.
 * `targetMessages` is a guess at how many resident array slots that takes,
 * because `makeMs` skips `disabled === true` and nothing here may read the
 * messages -- this runs before the first page request. The preload can read
 * them, so it takes the guess as an opening bid and keeps paging (never past
 * `residentCeiling`) if the chat turns out to be more disabled than the guess
 * assumed. Without that second figure a reader with a 60-message working set
 * and two of every three recent messages disabled got 43 of them, silently.
 *
 * WHAT IS IN THE TARGET, AND WHY EACH TERM
 *
 *  - the narrative working set (`risuBardResponseMessageCount`, default 12).
 *    This is the prompt's history. With `risuBardResponseExcludeUserMessages`
 *    the filter drops user messages BEFORE the slice, so `limit` surviving
 *    messages can need up to `2 x limit` raw ones in an alternating history --
 *    hence the doubling.
 *  - the recent-memory projection (`risuBardRecentMessageCount`, default 12),
 *    `memoryAnalysisClient.ts:466`, a `.slice(-limit)` over `chat.message`.
 *  - the lorebook scan (`lorebook.svelte.ts:132`), which slices `scanDepth`
 *    messages off the newest end of the RAW resident array. The effective depth
 *    is the MAXIMUM over every entry that can activate, not one setting: an
 *    entry may raise it with `@@scan_depth N`. Character globalLore, chat
 *    localLore and module lorebooks are all scanned by the same call, so all
 *    three are read here.
 *  - the confirmed-memory turn (`projectConfirmedMemoryTurn`), which walks back
 *    from the newest active message over about three messages.
 *
 * WHAT IS DELIBERATELY *NOT* IN IT
 *
 *  - Memory. `hypaMemoryV3` and the legacy supaMemory path take the already
 *    narrowed `OpenAIChat[]`; neither reads `chat.message`. Memory contributes
 *    nothing to how far back the load must go.
 *  - Trigger scripts and CBS tokens (`{{history}}`, `getChatMain(id, index)`,
 *    `v2GetMessageAtIndex`). These take an arbitrary index, or a depth that is
 *    only known at runtime from a chat variable. They cannot be bounded before
 *    the send by anything short of loading the entire conversation, which is
 *    what windowing exists to avoid. An out-of-range read has always returned
 *    `undefined`; that was true before the preload existed and the FLOOR below
 *    is what keeps it no worse than it was.
 *  - `runCurrentChatFunction` (`index.svelte.ts`), which runs every resident
 *    message through `risuChatParser` with `runVar: true` -- so a `{{setvar}}`
 *    written into an old message executes only while that message is resident.
 *    Same class as the above: the whole resident array, no depth to derive, and
 *    the floor is what keeps it no worse than the pre-preload window. It is
 *    also the reason the OLD behaviour was costly rather than merely wasteful:
 *    at 740 resident it parsed 740 messages on every single send.
 *  - `@@activate_only_after N` and friends, which want the conversation's TRUE
 *    LENGTH rather than a depth. No amount of loading satisfies those; the fix
 *    is for the lorebook to read the hydration window's `total`, which it now
 *    does (`lorebook.svelte.ts`), so they are correct at any resident count.
 */

/** One consumer's reach, kept for reporting and for tests to name. */
export interface PromptHistoryBoundTerm {
  /** The consumer. */
  name: string;
  /** How far back it reaches. */
  messages: number;
  /**
   * `enabled` counts messages the prompt can see (`disabled === true` skipped),
   * `raw` counts resident array slots. Only `enabled` terms get the disabled
   * headroom applied.
   */
  counts: "enabled" | "raw";
}

export interface PromptHistoryBound {
  /**
   * Resident messages to load before sending, or `undefined` when the
   * configuration cannot be bounded at all and the token budget is the only
   * stop left. `undefined` is the v0.3.17 behaviour, kept exactly, for the
   * cases that earn it.
   */
  targetMessages: number | undefined;
  /**
   * Messages the prompt can actually SEE that must be resident -- `disabled`
   * ones do not count towards it.
   *
   * `targetMessages` guesses how many resident slots that takes by doubling and
   * adding eight, because nothing here may read the messages. The preload can
   * read them, so it checks this figure against the real thing and keeps paging
   * if the guess was short. Without it, a chat whose recent history is more
   * than half disabled builds its prompt from fewer messages than the reader
   * configured, and nothing downstream says so.
   *
   * `undefined` alongside an `undefined` `targetMessages`: nothing is bounded.
   */
  targetEnabledMessages: number | undefined;
  /**
   * The hard stop on the walk, `MAX_RESIDENT_MESSAGES`. The enabled check above
   * can extend the load past `targetMessages`, and this is what stops it from
   * extending past the residency bound this whole change exists to restore.
   */
  residentCeiling: number;
  /** Why `targetMessages` is `undefined`, for the log line. */
  unboundedReason?: string;
  /** Every term that went into the target, largest first. */
  terms: PromptHistoryBoundTerm[];
}

/**
 * First guess at how many resident slots an `enabled` term takes.
 *
 * `makeMs` skips `disabled === true` outright, so N messages the prompt can see
 * may sit behind any number of disabled ones, and nothing here may read the
 * messages to find out -- this runs before the first page request. So it
 * guesses: double the requirement and add a fixed eight.
 *
 * A guess is all it is, and a guess alone would be a silent loss. A chat with
 * two of every three recent messages disabled needs THREE resident slots per
 * visible message, and at a raised working set this figure lands short of that
 * -- measured, before `targetEnabledMessages` existed, at 43 visible messages
 * where the reader had asked for 60. So the guess is only the opening bid: the
 * preload counts the visible messages it actually has and keeps paging (to
 * `PROMPT_HISTORY_CEILING_MESSAGES`) if this was optimistic. The doubling is
 * what makes that check cost nothing in the normal case, not what bounds it.
 *
 * Cheap, too: at defaults the doubled figure is still far under the floor, so
 * the headroom costs nothing at all until the configuration is already heavy.
 */
const DISABLED_HEADROOM_FACTOR = 2;
const DISABLED_HEADROOM_SLACK = 8;

/**
 * `projectConfirmedMemoryTurn` walks from the newest active message back to the
 * previous char message and the user message before it. Three, rounded up to
 * four so the walk is never the term that binds.
 */
const CONFIRMED_MEMORY_TURN_MESSAGES = 4;

/**
 * Never load LESS than the page a chat opens on.
 *
 * This floor is load-bearing and is the whole reason this change is not a
 * silent-loss defect. At defaults the derived requirement is twelve; without
 * the floor the preload would load nothing and every consumer that cannot be
 * bounded -- `{{history}}` inside a lorebook entry, a trigger script asking for
 * message 30, `{{previouscharchat}}` -- would see a window SHORTER than the one
 * it saw before the preload existed. The floor makes the change strictly a
 * reduction from v0.3.17's accidental 740 and never a regression against the
 * pre-preload baseline of 40.
 */
export const PROMPT_HISTORY_FLOOR_MESSAGES = OPEN_PAGE_MESSAGES;

/**
 * Never load more than the residency bound allows.
 *
 * This is the point of the exercise. Above `MAX_RESIDENT_MESSAGES` the trimmer
 * releases from the NEWEST end -- the tail the reply is about to be appended to
 * -- so a preload that walks past it is a preload fighting the memory bound it
 * is meant to respect. A configuration whose consumers genuinely ask for more
 * than this gets clamped, and the clamp is reported in the terms so it is not
 * silent.
 */
export const PROMPT_HISTORY_CEILING_MESSAGES = MAX_RESIDENT_MESSAGES;

/**
 * Module lorebooks, supplied by the caller rather than imported.
 *
 * `./modules` reaches `globalApi.svelte` and through it `streamsaver`, which
 * touches `document` at import time. Importing it here would make this module
 * -- which is otherwise pure arithmetic over settings -- unloadable in the
 * node-environment tests that measure the preload against a real server. The
 * caller already holds the getter; see `index.svelte.ts`.
 *
 * Omitting it under-counts the scan depth, so `sendChat` passing it is checked
 * by a source test in `promptHistoryBound.test.ts`.
 */
export type ModuleLorebookSource = () => Array<{ entry: loreBook }>;

function lorebookEntriesForChat(
  char: character,
  chat: Chat,
  moduleLorebooks: ModuleLorebookSource | undefined,
): loreBook[] {
  const entries: loreBook[] = [];
  for (const entry of char?.globalLore ?? []) if (entry) entries.push(entry);
  for (const entry of chat?.localLore ?? []) if (entry) entries.push(entry);
  try {
    for (const source of moduleLorebooks?.() ?? []) {
      if (source?.entry) entries.push(source.entry);
    }
  } catch {
    // Modules are resolved from live state that a send does not own. Failing to
    // read them must not fail the send; the base depth still applies and the
    // floor still holds.
  }
  return entries;
}

/**
 * The deepest history slice any activatable lorebook entry can ask for.
 *
 * Returns `null` when an entry's `@@scan_depth` argument does not parse.
 * `lorebook.svelte.ts:379` assigns `parseInt(arg[0])` with no NaN guard -- note
 * the `depth` case directly above it, which does guard -- and
 * `slice(len - NaN, len)` is `slice(0, len)`, i.e. the WHOLE resident array. An
 * entry written that way is asking for everything, so this refuses to invent a
 * number for it and the caller falls back to the token budget.
 */
function deepestLorebookScan(
  char: character,
  chat: Chat,
  db: Database,
  moduleLorebooks: ModuleLorebookSource | undefined,
): { depth: number; unboundedBy?: string } {
  const base = Math.max(0, char?.loreSettings?.scanDepth ?? db?.loreBookDepth ?? 0);
  let deepest = base;
  let unboundedBy: string | undefined;

  for (const entry of lorebookEntriesForChat(char, chat, moduleLorebooks)) {
    if (!isLorebookEntryEnabled(entry)) continue;
    // `alwaysActive` entries and keyed entries both reach the scan; a keyed
    // entry with no key never activates and cannot ask for a depth.
    if (!entry.alwaysActive && !entry.key) continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (!content.includes("@@")) continue;
    try {
      // The REAL decorator parser, the same call `loadLoreBookV3Prompt` makes.
      // Re-implementing the syntax here is how the two drift apart and how the
      // scan silently outgrows the load.
      CCardLib.decorator.parse(content, (name: string, arg: string[]) => {
        if (name !== "scan_depth") return false;
        const parsed = parseInt(arg?.[0]);
        if (Number.isNaN(parsed)) {
          unboundedBy ??= `a lorebook entry sets "@@scan_depth ${arg?.[0] ?? ""}", ` +
            "which the lorebook reads as the whole resident history";
          return;
        }
        if (parsed > deepest) deepest = parsed;
        return;
      });
    } catch {
      // An entry the parser chokes on is one whose decorators are unknown.
      // Treat it the way the lorebook will: it may scan anything.
      unboundedBy ??= "a lorebook entry's decorators could not be parsed";
    }
  }
  return { depth: deepest, unboundedBy };
}

/**
 * How many resident messages this send needs before its prompt is whole.
 *
 * Pure with respect to the chat: it reads settings and lorebook entries only,
 * never the messages, so it can be computed before the first page request.
 */
export function resolvePromptHistoryBound(
  char: character,
  chat: Chat,
  db: Database,
  moduleLorebooks?: ModuleLorebookSource,
): PromptHistoryBound {
  const settings = resolveRisuBardChatSettings(db, chat?.risuBardSettings);

  const narrativeLimit = normalizeNarrativeWorkingMessageLimit(
    settings.risuBardResponseMessageCount,
  );
  const narrativeReach = settings.risuBardResponseExcludeUserMessages
    ? narrativeLimit * 2
    : narrativeLimit;
  const recentMemoryReach = normalizeNarrativeWorkingMessageLimit(
    settings.risuBardRecentMessageCount,
  );
  const lore = deepestLorebookScan(char, chat, db, moduleLorebooks);

  const terms: PromptHistoryBoundTerm[] = ([
    { name: "narrative working set", messages: narrativeReach, counts: "enabled" },
    { name: "recent-memory projection", messages: recentMemoryReach, counts: "enabled" },
    { name: "lorebook scan depth", messages: lore.depth, counts: "raw" },
    { name: "confirmed-memory turn", messages: CONFIRMED_MEMORY_TURN_MESSAGES, counts: "enabled" },
  ] as PromptHistoryBoundTerm[]).sort((left, right) => right.messages - left.messages);

  if (lore.unboundedBy) {
    return {
      targetMessages: undefined,
      targetEnabledMessages: undefined,
      residentCeiling: PROMPT_HISTORY_CEILING_MESSAGES,
      unboundedReason: lore.unboundedBy,
      terms,
    };
  }

  const enabledReach = Math.max(narrativeReach, recentMemoryReach, CONFIRMED_MEMORY_TURN_MESSAGES);
  const rawReach = Math.max(
    enabledReach * DISABLED_HEADROOM_FACTOR + DISABLED_HEADROOM_SLACK,
    lore.depth,
  );

  const targetMessages = Math.min(
    PROMPT_HISTORY_CEILING_MESSAGES,
    Math.max(PROMPT_HISTORY_FLOOR_MESSAGES, Math.ceil(rawReach)),
  );
  return {
    targetMessages,
    targetEnabledMessages: Math.min(PROMPT_HISTORY_CEILING_MESSAGES, Math.ceil(enabledReach)),
    residentCeiling: PROMPT_HISTORY_CEILING_MESSAGES,
    terms,
  };
}
