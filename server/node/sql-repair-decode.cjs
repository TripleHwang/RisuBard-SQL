'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fflate = require('fflate');

// ---------------------------------------------------------------------------
// Repair decode budget.
//
// This is a DATA RECOVERY path: the user is one failed decode away from being
// told their character is gone. The budget is therefore sized to cover real
// databases and bias toward "try hard and take longer", while still keeping a
// hard ceiling so one repair cannot stall the server indefinitely.
//
// Every number below was fixed by measurement against saves built with this
// repo's own `encodeRisuSaveLegacy`, using two corpora that bracket real usage:
//
//   prose corpus  — long-form roleplay turns (~1KB/message)
//                   ~7,400 nodes/MB, heap ~= 10MB + 1.4 x decompressed
//   dense corpus  — short chat turns (~40 chars/message), the realistic worst
//                   case for node density and heap-per-byte
//                   ~57,500 nodes/MB, heap ~= 10MB + 3.9 x decompressed
//
// The dense corpus is what the old limits actually broke on: at ~57.5k
// nodes/MB the previous MAX_REPAIR_NODE_COUNT of 250,000 was exhausted by a
// ~4.3MB save, i.e. the STRUCTURAL cap bound roughly twice as early as the
// 8MB byte cap it was nominally paired with. Both are raised together here so
// they bind at the same scale.
//
// Measured (parent process on DEFAULT node flags — a parent
// --max-old-space-size silently overrides a worker's resourceLimits, so any
// measurement taken under one is meaningless):
//
//   dense   3.91MB /   0.23M nodes -> 29.6MB isolate, 0.20s
//   dense  58.42MB /   3.37M nodes ->  242MB isolate, 1.17s
//   dense 114.30MB /   6.57M nodes ->  460MB isolate, 2.06s
//   dense 191.69MB /  10.99M nodes ->  753MB isolate, 3.43s   <- at the cap
//   dense 315.23MB /  18.03M nodes -> rejected by preflight in 0.91s
//
// So 192MB decompressed needs ~800MB of isolate; 1280MB of old-generation
// leaves ~40% GC headroom at the cap, and 45s is ~13x the measured 3.4s
// worst case. `maxOldGenerationSizeMb` is a growth CEILING, not a
// reservation — a 3.91MB save still only touches ~30MB — so the generous
// ceiling costs nothing in the common case and only decides whether a large
// backup is recoverable at all.
//
// `MAX_REPAIR_BACKUP_BYTES` is aligned with the decompressed cap on purpose:
// `database/database.bin` and `database/pre-sql-migration-v1.bin` — the two
// highest-priority candidates — are written by `encodeRisuSaveLegacy(db)`
// with NO compression, so for them raw size == decompressed size. Leaving the
// raw cap at 64MB would reject exactly the most trusted sources long before
// the decompressed budget had any say.
const MAX_REPAIR_BACKUP_BYTES = 192 * 1024 * 1024;
const MAX_REPAIR_DECOMPRESSED_BYTES = 192 * 1024 * 1024;
// 192MB at the dense corpus's ~57.5k nodes/MB is ~11.0M nodes; 12M keeps the
// node cap from binding before the byte cap on any realistic shape.
const MAX_REPAIR_NODE_COUNT = 12_000_000;
// Measured maximum depth of a real save is 7. 128 is untouched — it exists to
// stop pathological nesting, and no realistic save comes near it.
const MAX_REPAIR_DEPTH = 128;
// A single very long chat is one array. 192MB of ~170-byte short messages is
// ~1.1M entries, so 2M leaves room without permitting an unbounded array.
const MAX_REPAIR_ARRAY_LENGTH = 2_000_000;
// String bytes can approach (never usefully exceed) the decompressed size,
// since msgpack stores UTF-8 inline. Set above the byte cap so this guard only
// fires on genuine expansion anomalies rather than shadowing the byte budget.
const MAX_REPAIR_STRING_BYTES = 256 * 1024 * 1024;
const REPAIR_DECODE_TIMEOUT_MS = 45_000;
const REPAIR_WORKER_OLD_HEAP_MB = 1280;
const REPAIR_WORKER_YOUNG_HEAP_MB = 64;
const RAW_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const COMPRESSED_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const STREAM_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const RISUSAVE_HEADER = Buffer.from('RISUSAVE\0');

function hasHeader(data, header) {
    return data.length >= header.length && data.subarray(0, header.length).equals(header);
}

function isGzipOrZlib(data) {
    return (data[0] === 0x1f && data[1] === 0x8b) || (data[0] === 0x78 && ((data[0] << 8) + data[1]) % 31 === 0);
}

function preflightCompressed(data, budget) {
    let size = 0;
    const decoder = new fflate.Decompress((chunk) => {
        size += chunk.length;
        if (size > budget.remaining) throw new Error('Repair backup exceeds decompressed limit');
    });
    for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        decoder.push(data.subarray(offset, Math.min(data.length, offset + 64 * 1024)), offset + 64 * 1024 >= data.length);
    }
    budget.remaining -= size;
}

function preflightRisuSave(data) {
    const budget = { remaining: MAX_REPAIR_DECOMPRESSED_BYTES };
    let offset = RISUSAVE_HEADER.length;
    while (offset < data.length) {
        if (offset + 3 > data.length) throw new Error('Malformed RisuSave block header');
        offset += 1; // type
        const compressed = data[offset++] === 1;
        const nameLength = data[offset++];
        if (offset + nameLength + 4 > data.length) throw new Error('Malformed RisuSave block header');
        offset += nameLength;
        const length = data.readUInt32LE(offset);
        offset += 4;
        if (length > data.length - offset) throw new Error('Malformed RisuSave block length');
        const block = data.subarray(offset, offset + length);
        offset += length;
        if (compressed) preflightCompressed(block, budget);
        else {
            budget.remaining -= block.length;
            if (budget.remaining < 0) throw new Error('Repair backup exceeds decompressed limit');
        }
    }
}

function preflightUnknownCompressed(data) {
    try {
        preflightCompressed(data, { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
        return true;
    } catch (error) {
        if (error?.message === 'Repair backup exceeds decompressed limit') throw error;
        return false;
    }
}

// Zero-copy Buffer view over an already-owned byte source. At a 192MB cap a
// defensive `Buffer.from(raw)` copy would double the worker's peak footprint
// for no benefit — the worker owns these bytes outright (they were transferred
// into it) and never mutates them.
function asBufferView(raw) {
    if (Buffer.isBuffer(raw)) return raw;
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    return Buffer.from(raw);
}

// An UNCOMPRESSED payload is its own decompressed form, so its budget check is
// just its length. This matters more than it looks: `database/database.bin` and
// `database/pre-sql-migration-v1.bin` are written by `encodeRisuSaveLegacy(db)`
// with no compression, so the two highest-priority repair candidates take this
// path. Before this check the RAW_HEADER and headerless-msgpack branches fell
// through preflight entirely and were bounded only by MAX_REPAIR_BACKUP_BYTES,
// leaving the decompressed budget with nothing to say about them.
function preflightUncompressed(byteLength) {
    if (byteLength > MAX_REPAIR_DECOMPRESSED_BYTES) throw new Error('Repair backup exceeds decompressed limit');
}

function preflightRepairBackup(raw) {
    const data = asBufferView(raw);
    if (hasHeader(data, COMPRESSED_HEADER)) return preflightCompressed(data.subarray(COMPRESSED_HEADER.length), { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    if (hasHeader(data, STREAM_HEADER)) return preflightCompressed(data.subarray(STREAM_HEADER.length), { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    if (hasHeader(data, RISUSAVE_HEADER)) return preflightRisuSave(data);
    if (hasHeader(data, RAW_HEADER)) return preflightUncompressed(data.length - RAW_HEADER.length);
    if (isGzipOrZlib(data)) return preflightCompressed(data, { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    // decodeRisuSave falls back to fflate.decompressSync for headerless data.
    // Probe that same family first; invalid raw/msgpack input is allowed through
    // to the normal decoder, while successful decompression is byte-bounded.
    // If it is not compressed at all, decodeRisuSave will unpack it as bare
    // msgpack, so bound it by its own length like any other uncompressed input.
    if (!preflightUnknownCompressed(data)) preflightUncompressed(data.length);
}

function assertRepairShape(value) {
    const stack = [{ value, depth: 0 }];
    let nodes = 0;
    let stringBytes = 0;
    while (stack.length) {
        const { value: current, depth } = stack.pop();
        if (++nodes > MAX_REPAIR_NODE_COUNT || depth > MAX_REPAIR_DEPTH) throw new Error('Repair backup exceeds structural limits');
        if (typeof current === 'string') {
            stringBytes += Buffer.byteLength(current, 'utf8');
            if (stringBytes > MAX_REPAIR_STRING_BYTES) throw new Error('Repair backup exceeds string limit');
        } else if (Array.isArray(current)) {
            if (current.length > MAX_REPAIR_ARRAY_LENGTH) throw new Error('Repair backup exceeds array limit');
            for (let index = current.length - 1; index >= 0; index--) stack.push({ value: current[index], depth: depth + 1 });
        } else if (current && typeof current === 'object') {
            for (const [key, child] of Object.entries(current)) {
                stringBytes += Buffer.byteLength(key, 'utf8');
                if (stringBytes > MAX_REPAIR_STRING_BYTES) throw new Error('Repair backup exceeds string limit');
                stack.push({ value: child, depth: depth + 1 });
            }
        }
    }
    return value;
}

async function decodeWorker(raw) {
    const { decodeRisuSave, normalizeJSON } = require('./utils.cjs');
    const data = asBufferView(raw);
    preflightRepairBackup(data);
    return assertRepairShape(normalizeJSON(await decodeRisuSave(data)));
}

async function readBoundedRisuSave(raw) {
    if (!raw || raw.byteLength > MAX_REPAIR_BACKUP_BYTES) return null;
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        let worker;
        try {
            // Hand the bytes to the worker by TRANSFER, not by structured
            // clone. With the raw cap at 192MB a clone would mean the parent
            // transiently holds two full copies of the backup. `new
            // Uint8Array(n)` always owns its ArrayBuffer, so transferring it
            // is safe — `Buffer.from(raw)` must NOT be used here because for
            // small inputs it can return a view into Node's shared 8KB buffer
            // pool, and transferring that would detach the pool process-wide.
            const view = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            const owned = new Uint8Array(view.byteLength);
            owned.set(view);
            worker = new Worker(__filename, {
                workerData: owned,
                transferList: [owned.buffer],
                resourceLimits: {
                    maxOldGenerationSizeMb: REPAIR_WORKER_OLD_HEAP_MB,
                    maxYoungGenerationSizeMb: REPAIR_WORKER_YOUNG_HEAP_MB,
                    stackSizeMb: 4,
                },
            });
        } catch { return finish(null); }
        timer = setTimeout(() => { worker.terminate().catch(() => {}); finish(null); }, REPAIR_DECODE_TIMEOUT_MS);
        worker.once('message', (message) => finish(message?.ok ? message.value : null));
        worker.once('error', () => finish(null));
        worker.once('exit', (code) => { if (code !== 0) finish(null); });
    });
}

if (!isMainThread && parentPort) {
    decodeWorker(workerData).then((value) => parentPort.postMessage({ ok: true, value }), () => parentPort.postMessage({ ok: false }));
}

module.exports = {
    readBoundedRisuSave,
    MAX_REPAIR_BACKUP_BYTES,
    MAX_REPAIR_DECOMPRESSED_BYTES,
    MAX_REPAIR_NODE_COUNT,
    MAX_REPAIR_ARRAY_LENGTH,
    MAX_REPAIR_STRING_BYTES,
    MAX_REPAIR_DEPTH,
    REPAIR_DECODE_TIMEOUT_MS,
    REPAIR_WORKER_OLD_HEAP_MB,
    REPAIR_WORKER_YOUNG_HEAP_MB,
};
