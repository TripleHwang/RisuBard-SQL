/**
 * The one place the reverse-page wire contract is written down, kept free of
 * every runtime import so BOTH sides can load it: the browser client
 * (`sqlRuntimeHydration.ts`) and the server test suite, which pins
 * `server/node/relational-sqlite.cjs`'s real responses against this exact
 * validator. Two shipped bugs in a row came from client fixtures that
 * hand-wrote a page shape the server never produces, so the fixture is no
 * longer allowed to be the arbiter.
 *
 * THE CONTRACT
 *
 * A reverse page is the messages with `position < before`, ascending, at most
 * `limit` of them (plus any rows tied at the page's lowest position — see
 * "Ties" below).
 *
 * - `before` is echoed verbatim from the request. It is the contiguity anchor:
 *   the page must abut the window it is being prepended to.
 * - `positions` are the exact persisted SQL positions, parallel to `messages`.
 *   They are sparse by design — 0, 4, 8, 12 is normal data — so nothing may
 *   require them to be dense.
 * - `hasMore` says whether older messages exist beyond this page.
 * - `nextBefore` is A CURSOR, not a description of this page: it is the value
 *   to send as `before` on the next request, and it is `null` exactly when
 *   there is no next request. So `hasMore === false` implies
 *   `nextBefore === null`, and `hasMore === true` implies
 *   `nextBefore === positions[0]` (the page's lowest position, since the next
 *   page is everything strictly below it).
 *
 * The cursor reading is what `nextBefore` is actually used for on both sides:
 * the client stores it in the window and feeds it straight back as `before`,
 * and `loadOlderChatMessages` already treats `nextBefore === null` as "stop".
 *
 * WHY THE VALIDATOR IS LENIENT ABOUT ONE HALF OF THAT
 *
 * Servers before this contract was written down returned the page's lowest
 * position on a terminal page too, instead of `null`. That is a disagreement
 * about a CONVENTION, not evidence of corrupt data: the page itself is
 * perfectly well-formed, and `hasMore === false` already stops the paging, so
 * the value can simply be ignored. Rejecting it bricked history browsing for
 * every user who reached the oldest message in a chat — a permanent Retry that
 * re-fetched the identical response forever.
 *
 * So: a terminal page may carry either `null` or its own lowest position, and
 * the client normalizes it to `null` when storing the window. Everything that
 * can actually hide or duplicate messages — position ordering, the `before`
 * anchor, the upper bound, duplicate IDs, the continuing-page cursor and
 * terminal coverage — stays strict.
 *
 * TIES
 *
 * `messages(chat_id, position)` has no UNIQUE constraint, so two messages can
 * share a position. Within one page that is harmless, and the validator
 * therefore requires positions to be non-DECREASING rather than strictly
 * increasing; identity is still enforced by the duplicate-ID check. What is
 * NOT harmless is a tied group split across a page boundary, because the
 * cursor is position-only and the next request (`position < tie`) would skip
 * the remainder of the group forever. The server is responsible for never
 * splitting one; it extends the page to cover the whole group instead.
 */

/** Structural shape of a reverse page. Deliberately not imported from
 *  `ISqlStorage` so this module keeps zero dependencies. */
export interface ReversePageShape {
  messages: { chatId?: string }[];
  positions: number[];
  before: number | null;
  nextBefore: number | null;
  total: number;
  hasMore: boolean;
}

export interface ReversePageWindowShape {
  nextBefore?: number | null;
}

/**
 * The cursor to store in the window after attaching `page`.
 *
 * Normalizing here is what makes the client independent of which convention
 * the server uses on a terminal page: a page with nothing older always lands
 * in the window as `hasOlder: false, nextBefore: null`, which is the state
 * `loadOlderChatMessages` reads as "do not request again".
 */
export function reversePageCursor(page: Pick<ReversePageShape, "hasMore" | "nextBefore">): number | null {
  return page.hasMore ? page.nextBefore : null;
}

/**
 * Reverse pages are a different contract from forward hydration: every page
 * must terminate exactly at the persisted boundary we asked for. Validate the
 * response before attaching positions or replacing either observable window.
 *
 * `total` and `nextPosition` are deliberately NOT compared against the stored
 * window. Server-side they are live chat-wide counters — `COUNT(*)` and
 * `COALESCE(MAX(position) + 1, 0)` over the whole chat, recomputed on every
 * page read — so they legitimately move the instant the chat grows or shrinks.
 * The window, by contrast, is captured once when the newest page is attached
 * and never re-established for the session. Comparing them turned "the user
 * sent one more message" into a permanent, retry-proof rejection of every
 * older page: identical inputs, identical failure, forever.
 *
 * The real contiguity invariant is the cursor echo. The server replies with
 * the exact `before` it was asked for, so `page.before === window.nextBefore`
 * still pins this page to the boundary the window ends at.
 *
 * `knownPersistedCount` is the number of already-loaded messages that carry a
 * canonical SQL position, which is exactly the set the server's `total`
 * counts. It is not `knownIds.size`: a locally appended message that has not
 * been through a dirty commit has no position and no row, so counting it would
 * let the terminal-coverage equality hold while older persisted messages were
 * still unfetched — concluding "we have everything" early and silently hiding
 * real history.
 */
export function validateOlderReversePage(
  page: ReversePageShape,
  window: ReversePageWindowShape,
  knownIds: Set<string | undefined>,
  knownPersistedCount: number,
): void {
  if (page.before !== window.nextBefore) {
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
    // Non-decreasing, not strictly increasing: tied positions are representable
    // in the schema and a tie inside one page loses nothing. Distinct rows are
    // still guaranteed distinct by the duplicate-ID check above.
    if (!Number.isSafeInteger(position) || position < previous || position >= (window.nextBefore ?? Infinity)) {
      throw new Error("Reverse page positions are noncontiguous")
    }
    seen.add(id)
    previous = position
  }
  // Positions ascend, so the page's own lowest position is `positions[0]`.
  const lowest = page.messages.length ? page.positions[0] : null
  if (page.hasMore) {
    // A page that claims more history but carries nothing cannot advance the
    // cursor; paging would spin on the same request. Name it distinctly.
    if (page.messages.length === 0) throw new Error("Reverse page claims older messages but returned none")
    if (page.nextBefore !== lowest) throw new Error("Reverse page boundary is noncontiguous")
  } else if (page.nextBefore !== null && page.nextBefore !== lowest) {
    // Terminal page: `null` (cursor convention) and the page's own lowest
    // position (older servers) are both accepted — see the header. Anything
    // else is a value neither side can explain, so it still fails.
    throw new Error("Reverse page boundary is noncontiguous")
  }
  if (!page.hasMore && knownPersistedCount + seen.size !== page.total) {
    throw new Error("Reverse page terminal coverage is incomplete")
  }
}
