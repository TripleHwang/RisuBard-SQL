export const RELATIONAL_SCHEMA_LAYOUT = "relational-schema-v3";
export const SQLITE_SCHEMA_VERSION = 3;
export const MAX_RELATIONAL_NODE_DEPTH = 128;
export const MAX_RELATIONAL_NODE_ROWS = 250_000;

/**
 * Above this many nodes, a value is stored as one canonical-JSON row instead of
 * being exploded into one row per scalar.
 *
 * The cap it replaces was unusable. `MAX_RELATIONAL_NODE_ROWS` mirrors the
 * server's `MAX_STATEMENTS_PER_COMMIT`, so a value needing more rows than that
 * could not be written by any means -- and `modules` is a single root key
 * holding every module a user has, lorebooks and all, re-encoded whole on every
 * change. The cap is on that array, not on one module: what crosses it is the
 * cumulative node count, which a user hit by importing a module they could not
 * then save. Raising the number only moves the wall, because a dirty
 * commit is one request whose statement budget is shared by every scope in the
 * flush, so a value that costs 250,000 INSERTs starves everything else even
 * when it fits.
 *
 * 20,000 is chosen against that budget rather than against the value: touching
 * one settings key can cost at most 8% of a commit, which leaves the rest of
 * the flush -- characters, chats, messages -- able to go with it. It is also
 * the same bound as `SQL_MIGRATION_CHUNK_STATEMENTS`, so no single value can
 * ever be larger than one migration chunk.
 *
 * Nothing queries these tables by node structure (`object_key` is only ever
 * read back, never matched on), so a value that stops being relational loses no
 * capability -- exactly the trade `bot_presets.data` already makes.
 */
export const MAX_RELATIONAL_NODE_ROWS_PER_VALUE = 20_000;

/**
 * Marker that says "this row's text is the whole value, as canonical JSON".
 *
 * It sits in `object_key` on the ROOT node, which is the one place in the
 * format that cannot already be occupied: the root is always appended as
 * `append(value, null, 0, null, 0)`, so `object_key` is NULL on the root of
 * every value any version of this codec has ever written. Reusing it therefore
 * needs no new column, no new `value_type` -- both `system_settings` and the
 * four `*_extension_nodes` tables pin theirs with a CHECK constraint listing
 * seven types -- and so no schema version bump.
 *
 * That last part is the point. A bump means `SqlSchemaResetRequiredError` for
 * every existing database, which for the database that reported this bug is a
 * multi-minute re-migration, and this fix has to be deployable to someone whose
 * app currently cannot save anything at all.
 */
export const RELATIONAL_JSON_NODE_KEY = "__risuRelationalJson";

/** Thrown when a value has more nodes than the caller allowed. */
export class RelationalRowLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Relational value exceeds maximum row count ${limit}`);
    this.name = "RelationalRowLimitError";
  }
}

export class SqlSchemaResetRequiredError extends Error {
  constructor(foundVersion: unknown, foundLayout: unknown) {
    super(
      `Local database reset required: found ${String(foundVersion)}/${String(foundLayout)}, expected ${SQLITE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}`,
    );
    this.name = "SqlSchemaResetRequiredError";
  }
}

export type RelationalNodeType =
  "null" | "undefined" | "boolean" | "number" | "string" | "array" | "object";

export interface RelationalNodeRow {
  [key: string]: unknown;
  node_id: number;
  parent_node_id: number | null;
  node_order: number;
  object_key: string | null;
  object_key_encoded: string | null;
  value_type: RelationalNodeType;
  text_value: string | null;
  encoded_text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
}

export interface RelationalNodeCodecOptions {
  maxDepth?: number;
  maxRows?: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeUtf16(value: string): string {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return bytesToBase64(bytes);
}

function decodeUtf16(value: string): string {
  const bytes = base64ToBytes(value);
  if (bytes.length % 2 !== 0)
    throw new Error("Invalid UTF-16 relational node value");
  let result = "";
  // Avoid apply/spread argument limits for large prompts.
  for (let index = 0; index < bytes.length; index += 2) {
    result += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
  }
  return result;
}

function isSqlTextSafe(value: string): boolean {
  if (value.includes("\0")) return false;
  // TextEncoder replaces unpaired surrogates. A round trip therefore also
  // acts as the portability check shared by SQLite, PostgreSQL, and Oracle.
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}

function encodedText(value: string): {
  text: string | null;
  encoded: string | null;
} {
  return isSqlTextSafe(value)
    ? { text: value, encoded: null }
    : { text: null, encoded: encodeUtf16(value) };
}

function decodedText(text: unknown, encoded: unknown): string {
  if (encoded !== null && encoded !== undefined)
    return decodeUtf16(String(encoded));
  return String(text ?? "");
}

function defineEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** One node's coordinates, handed to a walk's visitor. */
type RelationalVisit = (
  nodeId: number,
  parentNodeId: number | null,
  nodeOrder: number,
  key: string | null,
  current: unknown,
) => void;

/**
 * The single traversal every relational encoder and every relational check goes
 * through.
 *
 * Depth, cycles, unsupported types and the row limit are enforced here and
 * nowhere else, so "would this encode?" and "encode it" can never disagree --
 * which matters now that the first question is asked separately from the second
 * in order to refuse one root key without failing the commit around it.
 */
function walkRelationalValue(
  value: unknown,
  options: RelationalNodeCodecOptions,
  visit: RelationalVisit | null,
): number {
  const maxDepth = options.maxDepth ?? MAX_RELATIONAL_NODE_DEPTH;
  const maxRows = options.maxRows ?? MAX_RELATIONAL_NODE_ROWS;
  const ancestors = new Set<object>();
  let count = 0;

  const append = (
    current: unknown,
    parentNodeId: number | null,
    nodeOrder: number,
    key: string | null,
    depth: number,
  ): void => {
    if (depth > maxDepth)
      throw new Error(`Relational value exceeds maximum depth ${maxDepth}`);
    if (count >= maxRows) throw new RelationalRowLimitError(maxRows);

    const nodeId = count;
    count += 1;
    visit?.(nodeId, parentNodeId, nodeOrder, key, current);

    if (current === null || current === undefined) return;
    const kind = typeof current;
    if (kind === "boolean" || kind === "number" || kind === "string") return;
    if (kind !== "object")
      throw new TypeError(`Unsupported relational value type: ${kind}`);
    if (ancestors.has(current as object))
      throw new TypeError("Relational values cannot contain cycles");
    ancestors.add(current as object);
    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        append(item, nodeId, index, null, depth + 1),
      );
    } else {
      Object.entries(current as object).forEach(([childKey, item], index) =>
        append(item, nodeId, index, childKey, depth + 1),
      );
    }
    ancestors.delete(current as object);
  };

  append(value, null, 0, null, 0);
  return count;
}

/** The typed row for one node, given its coordinates. */
function relationalRow(
  nodeId: number,
  parentNodeId: number | null,
  nodeOrder: number,
  key: string | null,
  current: unknown,
): RelationalNodeRow {
  const encodedKey =
    key === null ? { text: null, encoded: null } : encodedText(key);
  const row: RelationalNodeRow = {
    node_id: nodeId,
    parent_node_id: parentNodeId,
    node_order: nodeOrder,
    object_key: encodedKey.text,
    object_key_encoded: encodedKey.encoded,
    value_type: "null",
    text_value: null,
    encoded_text_value: null,
    number_value: null,
    boolean_value: null,
  };
  if (current === null) return row;
  if (current === undefined) {
    row.value_type = "undefined";
    return row;
  }
  if (typeof current === "boolean") {
    row.value_type = "boolean";
    row.boolean_value = current ? 1 : 0;
    return row;
  }
  if (typeof current === "number") {
    row.value_type = "number";
    if (Number.isFinite(current)) row.number_value = current;
    else
      row.text_value = Number.isNaN(current)
        ? "NaN"
        : current > 0
          ? "Infinity"
          : "-Infinity";
    return row;
  }
  if (typeof current === "string") {
    row.value_type = "string";
    const encoded = encodedText(current);
    row.text_value = encoded.text;
    row.encoded_text_value = encoded.encoded;
    return row;
  }
  if (typeof current === "object")
    row.value_type = Array.isArray(current) ? "array" : "object";
  return row;
}

/**
 * Flattens a JavaScript value into typed adjacency-list rows. No JSON text is
 * involved, and empty containers, null, object insertion order, NUL, and
 * unpaired UTF-16 surrogates survive a round trip.
 */
export function flattenRelationalValue(
  value: unknown,
  options: RelationalNodeCodecOptions = {},
): RelationalNodeRow[] {
  const rows: RelationalNodeRow[] = [];
  walkRelationalValue(value, options, (...node) =>
    void rows.push(relationalRow(...node)),
  );
  return rows;
}

/**
 * How many rows a value would flatten into, allocating none of them.
 *
 * Validates exactly what flattening validates, which is what makes it usable as
 * the "can this key be written at all?" question a commit asks before deciding
 * whether to include the key or refuse it.
 */
export function measureRelationalValue(
  value: unknown,
  options: RelationalNodeCodecOptions = {},
): number {
  return walkRelationalValue(
    value,
    { maxRows: Number.POSITIVE_INFINITY, ...options },
    null,
  );
}

/**
 * The `system_settings` / root descriptor for a value: its own type, without
 * walking a single child.
 *
 * `system_settings` has no `object_key` column, so a JSON-spilled value cannot
 * carry its marker there -- and must not be registered as the string it spilled
 * into. This gives that table the value's real type, and it replaces a
 * `flattenRelationalValue(value)[0]` that walked an entire module tree to read
 * row zero.
 */
export function relationalRootDescriptor(value: unknown): RelationalNodeRow {
  return relationalRow(0, null, 0, null, value);
}

/** The single row a spilled value is stored as. */
function relationalJsonRow(value: unknown): RelationalNodeRow {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError("Relational value has no JSON representation");
  const encoded = encodedText(json);
  return {
    node_id: 0,
    parent_node_id: null,
    node_order: 0,
    object_key: RELATIONAL_JSON_NODE_KEY,
    object_key_encoded: null,
    value_type: "string",
    text_value: encoded.text,
    encoded_text_value: encoded.encoded,
    number_value: null,
    boolean_value: null,
  };
}

export interface RelationalEncodeOptions extends RelationalNodeCodecOptions {
  /** Node count above which the value is stored as one JSON row. */
  spillAbove?: number;
}

/**
 * The rows to store for one value: exploded when that is a reasonable number of
 * rows, one canonical-JSON row when it is not.
 *
 * The value is measured first, so the choice is made on the whole tree and the
 * same validation runs either way -- a cycle or a BigInt is refused before the
 * size question is even asked, rather than being quietly dropped by
 * `JSON.stringify` on the spill path.
 *
 * The spill is not lossless in the way the node format is: `undefined`, `NaN`
 * and the infinities become `null` or disappear. For root settings on the Node
 * backend that changes nothing, because bootstrap already ships every setting
 * value as JSON over HTTP and has always lost exactly those. It also makes a
 * spilled value fingerprint-identical to itself under
 * `snapshotCompatibility`'s `JSON.stringify`, so a round trip through storage
 * cannot show up as a spurious edit on the next audit.
 */
export function encodeRelationalNodeRows(
  value: unknown,
  options: RelationalEncodeOptions = {},
): RelationalNodeRow[] {
  const spillAbove = options.spillAbove ?? MAX_RELATIONAL_NODE_ROWS_PER_VALUE;
  const { spillAbove: _ignored, ...codecOptions } = options;
  const rows = measureRelationalValue(value, codecOptions);
  if (rows <= spillAbove) return flattenRelationalValue(value, codecOptions);
  return [relationalJsonRow(value)];
}

export function rebuildRelationalValue(
  input: readonly Record<string, unknown>[],
): unknown {
  if (input.length === 0) throw new Error("Relational value has no root node");
  const rows = [...input].sort(
    (left, right) => Number(left.node_id) - Number(right.node_id),
  );
  if (Number(rows[0].node_id) !== 0 || rows[0].parent_node_id !== null) {
    throw new Error("Relational value has an invalid root node");
  }
  // A value stored as canonical JSON, written by `encodeRelationalNodeRows`
  // when exploding it would have cost more rows than a commit can afford. It is
  // always exactly one row, and its root carries an `object_key` that a
  // flattened root never can, so this can neither miss one nor claim one.
  if (
    rows.length === 1 &&
    rows[0].object_key === RELATIONAL_JSON_NODE_KEY &&
    rows[0].value_type === "string"
  ) {
    return JSON.parse(
      decodedText(rows[0].text_value, rows[0].encoded_text_value),
    );
  }
  const children = new Map<number, Record<string, unknown>[]>();
  for (const row of rows.slice(1)) {
    const parent = Number(row.parent_node_id);
    if (!Number.isSafeInteger(parent))
      throw new Error("Relational node has no parent");
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort(
      (left, right) => Number(left.node_order) - Number(right.node_order),
    );
  }

  const build = (row: Record<string, unknown>, depth: number): unknown => {
    if (depth > MAX_RELATIONAL_NODE_DEPTH)
      throw new Error("Relational value exceeds maximum depth");
    switch (row.value_type) {
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "boolean":
        return Boolean(row.boolean_value);
      case "number": {
        if (row.text_value === "NaN") return Number.NaN;
        if (row.text_value === "Infinity") return Number.POSITIVE_INFINITY;
        if (row.text_value === "-Infinity") return Number.NEGATIVE_INFINITY;
        return Number(row.number_value);
      }
      case "string":
        return decodedText(row.text_value, row.encoded_text_value);
      case "array":
        return (children.get(Number(row.node_id)) ?? []).map((child) =>
          build(child, depth + 1),
        );
      case "object": {
        const result: Record<string, unknown> = {};
        for (const child of children.get(Number(row.node_id)) ?? []) {
          const key = decodedText(child.object_key, child.object_key_encoded);
          defineEntry(result, key, build(child, depth + 1));
        }
        return result;
      }
      default:
        throw new Error(
          `Unknown relational node type: ${String(row.value_type)}`,
        );
    }
  };
  return build(rows[0], 0);
}

export const RELATIONAL_NODE_COLUMNS = [
  "node_id",
  "parent_node_id",
  "node_order",
  "object_key",
  "object_key_encoded",
  "value_type",
  "text_value",
  "encoded_text_value",
  "number_value",
  "boolean_value",
] as const;
