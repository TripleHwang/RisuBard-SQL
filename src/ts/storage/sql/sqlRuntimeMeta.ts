/**
 * Symbol-keyed runtime metadata for SQL-backed hydration.
 *
 * `DBState.db` is a Svelte 5 `$state` proxy. Svelte 5 state proxies reject
 * fixed property descriptors (`Object.defineProperty`) with
 * `state_descriptors_fixed` — the pattern this module previously used
 * (`Object.defineProperty(chat, "_sqlWindow", { enumerable: false, ... })`)
 * throws the moment `chat` is a real reactive proxy instead of a plain test
 * object.
 *
 * Plain assignment (`obj[SYMBOL] = value`) is allowed on a state proxy — the
 * proxy's `set` trap handles it like any other property. Using module-local
 * `Symbol()` keys (rather than plain string fields) gives the same
 * "invisible to casual enumeration" guarantee the old non-enumerable
 * descriptor gave, for free:
 *  - `Object.keys` / `for...in` / `JSON.stringify` never see symbol keys.
 *  - `structuredClone` and `$state.snapshot` drop symbol-keyed properties.
 *  - Object *spread* (`{ ...obj }`) and rest-destructuring DO copy symbol
 *    keys (they copy all own enumerable properties, symbols included).
 *    Callers that spread a chat/message to build persisted SQL row data
 *    (see `sqlChatData` / `sqlMessageData` / `sqlCharacterData` in
 *    ./sqlCommit) MUST strip these keys explicitly — `stripSqlRuntimeMeta`
 *    below does that.
 */

/** In-memory reverse-page hydration window attached to a runtime Chat. */
export type SqlHydrationWindow = {
  before?: number | null;
  nextBefore?: number | null;
  total?: number;
  hasOlder?: boolean;
  nextPosition?: number;
  /** Reserved for future long-running full-history operations; never set today. */
  fullHistoryOperation?: boolean;
  /** Reserved for future long-running full-history operations; never set today. */
  loading?: boolean;
};

const SQL_WINDOW = Symbol("sqlWindow");
const SQL_POSITION = Symbol("sqlPosition");

type WithSqlWindow = { [SQL_WINDOW]?: SqlHydrationWindow };
type WithSqlPosition = { [SQL_POSITION]?: number };

/** Read the reverse-page hydration window attached to a runtime chat, if any. */
export function getSqlWindow(chat: object | null | undefined): SqlHydrationWindow | undefined {
  return (chat as WithSqlWindow | null | undefined)?.[SQL_WINDOW];
}

/** Attach/replace the reverse-page hydration window on a runtime chat. */
export function setSqlWindow(chat: object, window: SqlHydrationWindow): void {
  (chat as WithSqlWindow)[SQL_WINDOW] = window;
}

/** Remove the reverse-page hydration window from a runtime chat, if present. */
export function clearSqlWindow(chat: object): void {
  delete (chat as WithSqlWindow)[SQL_WINDOW];
}

/** Read the canonical SQL row position attached to a runtime message, if any. */
export function getSqlPosition(message: object | null | undefined): number | undefined {
  return (message as WithSqlPosition | null | undefined)?.[SQL_POSITION];
}

/** Attach/replace the canonical SQL row position on a runtime message. */
export function setSqlPosition(message: object, position: number): void {
  (message as WithSqlPosition)[SQL_POSITION] = position;
}

/** Remove the canonical SQL row position from a runtime message, if present. */
export function clearSqlPosition(message: object): void {
  delete (message as WithSqlPosition)[SQL_POSITION];
}

/**
 * Strip runtime-only SQL metadata symbols from an object that was produced by
 * spreading a live chat/message (`{ ...chat }`, `const { id, ...rest } = chat`).
 * Spread copies symbol-keyed own properties, unlike `structuredClone`,
 * `JSON.stringify`, or `$state.snapshot` — this is the one place those
 * symbols can otherwise leak into persisted SQL row data.
 */
export function stripSqlRuntimeMeta<T extends object>(data: T): T {
  delete (data as WithSqlWindow)[SQL_WINDOW];
  delete (data as WithSqlPosition)[SQL_POSITION];
  return data;
}

/** True if a symbol-keyed runtime metadata field is present on the object (test/diagnostic use only). */
export function hasSqlRuntimeMeta(value: object | null | undefined): boolean {
  if (!value) return false;
  return Object.getOwnPropertySymbols(value).some((symbol) => symbol === SQL_WINDOW || symbol === SQL_POSITION);
}
