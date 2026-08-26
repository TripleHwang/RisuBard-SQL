# Server-Assisted CharX Import Design

**Status:** Approved for implementation planning

**Date:** 2026-08-26

## Problem

CharX import currently decompresses every ZIP entry in the browser, accumulates each
entry in an `AppendableBuffer`, hashes assets, and sends asset batches through the
storage abstraction. In Node deployments, `NodeStorage.setItems` additionally turns
those assets into Base64 JSON before uploading them back to the same server.

On Android Chrome, a roughly 130 MB CharX archive can therefore create several
simultaneous decompressed buffers, buffer copies, Base64 strings, and serialized JSON
bodies. The Android renderer can be killed by the operating system while the UI still
shows `Loading... (Reading)`. A renderer kill does not produce a JavaScript exception
or a Chrome error code that the application can display.

Small imports succeed because they do not cross the renderer's practical memory
limit. The amount of device-wide free RAM is not a reliable estimate of the memory
available to one Chrome renderer.

## Goals

- Keep CharX import memory bounded in the browser for Node-hosted deployments.
- Upload the selected `File` as raw binary without first materializing it as a browser
  `ArrayBuffer`, Base64 string, or JSON value.
- Stream ZIP extraction and asset persistence on the Node server.
- Reuse the existing client-side character conversion, module merge, lorebook merge,
  ordering, and redirect behavior.
- Keep the existing browser importer for non-Node deployments.
- Preserve the existing CharX asset mapping contract: ZIP entry name to
  `assets/<sha256>.png` storage key.
- Report actionable import failures in the UI instead of silently attempting a
  browser fallback that may crash again.

## Non-goals

- Moving the complete character database mutation workflow to the Node server.
- Adding resumable or chunk-addressed uploads in the first version.
- Changing the CharX format or the on-disk RisuVault database format.
- Replacing the existing browser importer for static, account, or other non-Node
  deployments.
- Guaranteeing transactionality across both the server asset commit and the later
  client database commit. Content-addressed assets may remain after a client-side
  finalization failure, just as they can in the current import path.

## Chosen Approach

Use a hybrid, server-assisted import in Node environments:

1. The browser uploads the original CharX `File` to an authenticated Node endpoint.
2. The Node server incrementally parses the ZIP stream.
3. Metadata entries are retained under strict small limits; asset entries are streamed
   to generated staging paths rather than accumulated in memory.
4. The server hashes and publishes all accepted assets to file-native storage as one
   manifest commit.
5. The server returns the parsed card, optional module bytes, asset mapping, and
   exclusions as a small result message.
6. The browser runs the existing `readModule` and `importCharacterCardSpec` flow to
   finish the import.

When `isNodeServer` is false, the current `CharXImporter` path remains unchanged.
When `isNodeServer` is true, a server failure is surfaced to the user; it does not
automatically retry through the memory-heavy browser path.

This approach is preferred over a fully server-owned import because the character
conversion and database integration logic is coupled to the existing TypeScript/Svelte
client. Duplicating it in CommonJS server code would create two behavioral sources of
truth. It is preferred over resumable upload for the initial version because the known
deployment is a direct Tailscale connection and the additional session lifecycle is not
required to solve the renderer crash.

## Architecture

### Client selection and finalization

`importCharacterProcess` keeps ownership of format selection and final character
creation. For a `.charx` file:

- In Node mode, it calls a new storage capability such as
  `importCharX(file, onProgress)`.
- In non-Node mode, it creates the existing `CharXImporter` and follows the existing
  browser flow.
- A successful server result is adapted to the same values currently obtained from
  `CharXImporter`: card data, optional module data, asset map, and excluded files.
- The existing `readModule` and `importCharacterCardSpec` calls remain the only code
  that mutates the character database.

The server capability belongs on `NodeStorage` and is forwarded by `AutoStorage`,
matching the established backup-import transport boundary. The general browser
storage interface does not need to pretend that server-assisted CharX import exists in
non-Node environments.

### Transport

Add an authenticated endpoint:

```text
POST /api/charx/import
Content-Type: application/x-risu-charx
Accept: application/x-ndjson
risu-auth: <token>
x-session-id: <active writer session>
Body: raw CharX bytes
```

The endpoint must be excluded from global Express body parsers, as
`/api/backup/import` already is. It consumes `req` as a stream and never reads the
archive from `req.body` or concatenates the full request into a `Buffer`.

The client uses `XMLHttpRequest`, following the existing backup-import implementation,
so upload progress is available without reading the file into JavaScript memory.
Authentication and active-session headers are identical to other mutating Node
operations.

The response is newline-delimited JSON. Progress messages keep a long-running response
alive after upload completion and the final line contains the result:

```json
{"type":"progress","phase":"extracting","completed":12,"total":40}
{"type":"done","result":{"card":{},"moduleBase64":null,"assets":{},"excludedFiles":[],"warnings":[]}}
```

Errors use an appropriate HTTP status when headers have not been sent. If NDJSON has
already started, the final message is
`{"type":"error","code":"...","message":"..."}` and the connection closes.
Internal paths and stack traces are logged server-side but are not returned.

### Server extraction helper

ZIP parsing lives in a focused CommonJS helper rather than expanding
`server/node/server.cjs` with archive state-machine details. The helper accepts:

- the request readable stream;
- a newly created staging directory;
- configured limits;
- a persistence callback;
- a progress callback; and
- an abort signal tied to request disconnect and server shutdown.

It returns the protocol result only after parsing, validation, and asset publication
complete.

Each accepted asset is written to a generated filename inside the staging directory.
ZIP entry names are metadata only and are never joined to a filesystem path. Write
stream backpressure pauses request consumption until the staging sink drains. The
implementation must bound queued decompressed chunks rather than relying only on the
compressed request stream's backpressure.

`card.json` and `module.risum` are the only entries retained in memory. All other JSON
entries continue to be ignored for compatibility. Directory entries are ignored. All
other regular files are assets.

### Asset publication

Extend the file-native KV boundary with a batch operation equivalent to
`kvSetManyFromFilesAsync([{ key, sourcePath }])`.

The operation:

1. streams each staging file through the existing content-object writer;
2. verifies the SHA-256 content object;
3. prepares manifest entries without exposing them yet;
4. applies every prepared `assets/<sha256>.png` entry to one manifest copy; and
5. atomically saves the updated manifest.

The ZIP-entry-to-storage-key map is created from each asset's SHA-256 digest. Identical
assets naturally share a storage key. If preparation fails, no partial asset keys are
added to the manifest. Content objects created before failure are unreferenced and may
be reclaimed by the existing object-store garbage collector.

This adds a narrow reusable capability to `file-kv.cjs`; it does not expose internal
manifest structures to the CharX route.

## Validation and Resource Limits

Limits are checked incrementally so an attacker cannot bypass them with absent or
incorrect ZIP metadata.

- Compressed request body: maximum 256 MiB; reject known oversized `Content-Length`
  before processing and stop once the streamed count exceeds the limit.
- Total decompressed data: maximum 2 GiB across all entries.
- Entry count: maximum 10,000 regular entries.
- `card.json`: exactly one, maximum 4 MiB, valid UTF-8 JSON, and a character card with
  `spec` equal to `chara_card_v3`, matching the existing CharX entry-point validation.
- `module.risum`: zero or one, maximum 16 MiB.
- Asset entry: preserve the existing 50 MiB per-file behavior. Oversized assets are
  drained but excluded and reported rather than failing the whole import.
- Entry names: reject NUL bytes, absolute paths, drive prefixes, backslashes,
  traversal components, and duplicate normalized names.
- ZIP parser/decompression errors, encrypted entries, unsupported compression, and
  truncated input fail the complete import. The existing fflate streaming API does
  not expose central-directory CRC values, so CRC verification is not added in this
  change.

The route checks authentication and the active writer session before consuming the
body. A process-local CharX import lock permits one server-assisted CharX import at a
time. It remains separate from the destructive full-backup-import lock but both locks
must reject concurrent operation with the other, because backup replacement can
invalidate asset state.

These defaults are server constants and can be changed later without changing the
wire protocol.

## Cleanup and Failure Semantics

A unique staging directory is created below the configured data root, not in the
current working directory. Cleanup runs in `finally` on success, parser error, storage
error, limit rejection, authentication/session loss, or client disconnect.

Failure behavior is deliberately asymmetric:

- Before asset publication: no manifest keys become visible.
- During asset publication: the file-KV batch operation either commits all keys or no
  keys. Unreferenced content objects are safe to collect later.
- After publication but before the client database save: assets can remain without a
  character reference. They are content-addressed, deduplicated, and safe; the server
  must not blindly delete them because another character may already use the same
  keys.
- Client database finalization failure: show the actual error and leave the current
  character database unchanged according to the existing import function's behavior.

Expected protocol error codes include `INVALID_CHARX`, `CHARX_LIMIT_EXCEEDED`,
`CHARX_BUSY`, `INSUFFICIENT_STORAGE`, `IMPORT_ABORTED`, and `ASSET_COMMIT_FAILED`.
User-visible text should describe the action, not expose these codes alone.

## User Experience

The existing blocking import alert remains, with Node-mode phases that distinguish the
long operation:

- `Uploading CharX…` with uploaded bytes when available;
- `Processing CharX on server…` with entry progress after upload; and
- `Finalizing character…` while existing client logic runs.

Excluded assets produce one summary warning after a successful import. A connection
failure says that the server import failed and that the character was not imported. It
does not trigger a browser-side retry. Retrying the user action sends the full file
again in version one.

## Compatibility

- Node deployments automatically use the new route for `.charx` files of every size,
  avoiding two Node-mode implementations with size-dependent behavior.
- Non-Node deployments retain the current importer and current limits.
- Card v3 acceptance, module/lorebook integration, `returnCharacter`, character
  ordering, success notification, and navigation behavior stay in the existing client
  code.
- The result asset map uses the same original ZIP names and storage-key format as the
  current `CharXImporter`.
- No database migration or CharX format migration is required.
- Client and server are shipped together by the existing updater. A stale server that
  lacks the endpoint returns a visible version/update error rather than falling back to
  browser extraction.

## Testing Strategy

### Server extraction tests

- Valid card-only, card-plus-module, and multi-asset archives.
- Asset filenames map to the expected SHA-256 storage keys.
- Input is consumed incrementally and asset output honors simulated sink
  backpressure.
- A synthesized 130 MB-class archive succeeds without any full-request
  `Buffer.concat` path. The fixture is generated in a temporary directory and is not
  checked into the repository.
- Invalid ZIP, truncated ZIP, missing/duplicate card, duplicate normalized name,
  traversal name, encrypted entry, and unsupported compression cases.
- Compressed-size, decompressed-size, entry-count, card-size, module-size, and
  per-asset-size boundaries.
- Abort and injected disk-write failure remove staging data.

### File-KV tests

- File-backed batch publication produces correct content objects and keys.
- Manifest visibility changes only after every source file is prepared.
- An injected preparation failure leaves the prior manifest unchanged.
- Duplicate content and pre-existing objects remain idempotent.

### Route tests

- Authentication and active writer-session enforcement.
- CharX/backup mutual exclusion and `423`/`409` behavior.
- Global JSON/raw middleware does not buffer the CharX request.
- NDJSON progress, done, and post-header error records.
- Disconnect aborts processing and releases the lock.

### Client tests

- Node mode selects server-assisted import and never constructs `CharXImporter`.
- Non-Node mode retains the current path.
- Server results feed the existing module and character import logic unchanged.
- Upload, processing, finalization, exclusion warning, stale-server, and failure UI.
- A server error does not invoke browser fallback.

## Expected Change Surface

Production changes are expected in approximately six files:

- `src/ts/characterCards.ts`
- `src/ts/storage/autoStorage.ts`
- `src/ts/storage/nodeStorage.ts`
- `server/node/server.cjs`
- `server/node/file-kv.cjs`
- a new focused `server/node/charx-import.cjs`

Tests will add or modify roughly three to four files. No schema, migration, or build
pipeline change is expected. The implementation is therefore a moderate change: larger
than a client batching tweak, but substantially smaller and safer than moving full
character creation to the server.

## Deferred Follow-up

If whole-file retries become a real problem outside the direct Tailscale use case, add
a resumable upload protocol as a separate feature. That design would introduce upload
session IDs, fixed-size chunks, offset verification, expiry, and abandoned-session
cleanup without changing the server extraction result or client finalization contract
defined here.
