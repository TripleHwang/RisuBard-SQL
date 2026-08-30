/**
 * The guard that stands in for `UNIQUE (chat_id, position)` on `messages`.
 *
 * WHY THERE IS NO UNIQUE CONSTRAINT.
 *
 * A message's `position` is its index in `chat.message`, and the delta writer
 * (`sqlDelta.ts` -> `sqliteCommit.ts`) sends one upsert per changed message
 * followed by the manifest DELETE that prunes removed ids. Inside that one
 * transaction, positions collide by design:
 *
 *   - Delete a message from the middle. Every later message shifts down one, so
 *     the upsert of the message that moves into slot N runs while the row being
 *     deleted still occupies slot N. The DELETE is the last statement.
 *   - Insert a message into the middle. Every later message shifts UP one, and
 *     the upserts run in ascending order, so slot N+1 is still held by the row
 *     that is about to vacate it. No reordering of statements fixes this one:
 *     ascending order breaks inserts, descending order breaks deletes.
 *
 * SQLite checks uniqueness per statement and has no deferrable unique
 * constraint (`PRAGMA defer_foreign_keys` covers foreign keys only), so both
 * cases raise `UNIQUE constraint failed: messages.chat_id, messages.position`
 * and abort the commit. The canonical single-statement shift,
 * `UPDATE messages SET position = position + 1 WHERE ... AND position >= ?`,
 * fails for the same reason. All three were run against a real `node:sqlite`
 * database with the index in place; `messagePositionIntegrity.test.ts` keeps
 * that evidence executable rather than anecdotal.
 *
 * So adding the constraint would not catch corruption -- it would make ordinary
 * message editing fail, which is strictly worse than the invisible duplicate it
 * is meant to prevent.
 *
 * Making it addable would mean a two-phase position write: park every row whose
 * position moves at a value outside the live range, write the final positions,
 * then prove nothing was left parked. That relaxes `CHECK (position >= 0)`,
 * doubles the statements on every reordering commit, and introduces a new
 * failure mode (a commit that dies mid-flight leaves rows parked and invisible
 * to every `ORDER BY position` reader) in exchange for guarding a state no
 * observed defect has produced. That trade is not worth making silently, so it
 * is written down here rather than taken.
 *
 * WHAT GUARDS THE INVARIANT INSTEAD.
 *
 * This check. Duplicate positions are not harmless: every read path orders by
 * `position` with `LIMIT`/`OFFSET` (`webSqliteStorage.loadChatMessagePage`), so
 * a tie makes pagination non-deterministic -- a page can repeat one message and
 * drop another. That is exactly the "corruption nothing reports" case. It is
 * reported, loudly and by name, and it is never repaired automatically: the
 * repair for a tie is to choose which message comes first, and only the reader
 * of the conversation can do that. Silence, not the duplicate, was the defect.
 */

export interface DuplicateMessagePosition {
  chatId: string;
  position: number;
  occurrences: number;
}

/**
 * Bounded on purpose. This runs at startup, and a database that has gone wrong
 * badly enough to fill this list is already fully diagnosed by the first few
 * rows; the count query below reports the real total.
 */
export const DUPLICATE_MESSAGE_POSITION_SAMPLE = 20;

/**
 * Served by `messages_chat_position_idx`, so this is an index scan rather than
 * a table scan.
 */
export const DUPLICATE_MESSAGE_POSITION_SQL =
  `SELECT chat_id, position, COUNT(*) AS occurrences
   FROM messages
   GROUP BY chat_id, position
   HAVING COUNT(*) > 1
   ORDER BY chat_id, position
   LIMIT ${DUPLICATE_MESSAGE_POSITION_SAMPLE}`;

/** Rows straight from the driver, whatever shape it hands back. */
export type RawRow = Record<string, unknown>;

export function toDuplicateMessagePositions(rows: RawRow[]): DuplicateMessagePosition[] {
  return rows.map((row) => ({
    chatId: String(row.chat_id ?? ""),
    position: Number(row.position ?? -1),
    occurrences: Number(row.occurrences ?? 0),
  }));
}

/**
 * Ready-to-read text. Names the affected chats and what it means for reading
 * them, because a bare count tells the reader nothing they can act on.
 */
export function describeDuplicateMessagePositions(
  duplicates: DuplicateMessagePosition[],
): string {
  if (duplicates.length === 0) return "";
  const chats = [...new Set(duplicates.map((duplicate) => duplicate.chatId))];
  const sample = duplicates
    .slice(0, 5)
    .map((duplicate) =>
      `chat ${duplicate.chatId} position ${duplicate.position} x${duplicate.occurrences}`
    )
    .join("; ");
  const more = duplicates.length > 5 ? `; and ${duplicates.length - 5} more` : "";
  return (
    `${duplicates.length} duplicated message position(s) across ${chats.length} chat(s). ` +
    "Messages are read in `position` order with LIMIT/OFFSET, so a duplicated position makes " +
    "paging through those chats non-deterministic: a page can repeat one message and skip " +
    `another. Nothing was changed automatically. Affected: ${sample}${more}.`
  );
}

/**
 * Run the check and report it. Returns what it found so a caller can assert on
 * it; never throws for a duplicate, because a startup that refuses to open the
 * database is a worse outcome than a startup that says what is wrong.
 *
 * A failure of the *query itself* is reported and rethrown by the caller's
 * choice: `select` failing means the check did not run, which is "unknown", not
 * "clean", and returning an empty array for it would be the silent fallback
 * this whole module exists to avoid. Hence the throw.
 */
export function checkMessagePositionIntegrity(
  select: (sql: string) => RawRow[],
  report: (message: string) => void = (message) => console.error(message),
): DuplicateMessagePosition[] {
  let rows: RawRow[];
  try {
    rows = select(DUPLICATE_MESSAGE_POSITION_SQL);
  } catch (error) {
    throw new Error(
      "The message-position integrity check could not run, so whether any chat has duplicated " +
        `message positions is unknown: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const duplicates = toDuplicateMessagePositions(rows);
  if (duplicates.length > 0) {
    report(`[SQL integrity] ${describeDuplicateMessagePositions(duplicates)}`);
  }
  return duplicates;
}
