'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const fflate = require('fflate');

const MAX_REPAIR_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_REPAIR_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_REPAIR_NODE_COUNT = 250_000;
const MAX_REPAIR_DEPTH = 128;
const MAX_REPAIR_ARRAY_LENGTH = 100_000;
const MAX_REPAIR_STRING_BYTES = 32 * 1024 * 1024;
const REPAIR_DECODE_TIMEOUT_MS = 12_000;
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

function preflightRepairBackup(raw) {
    const data = Buffer.from(raw);
    if (hasHeader(data, COMPRESSED_HEADER)) return preflightCompressed(data.subarray(COMPRESSED_HEADER.length), { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    if (hasHeader(data, STREAM_HEADER)) return preflightCompressed(data.subarray(STREAM_HEADER.length), { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    if (hasHeader(data, RISUSAVE_HEADER)) return preflightRisuSave(data);
    if (isGzipOrZlib(data)) return preflightCompressed(data, { remaining: MAX_REPAIR_DECOMPRESSED_BYTES });
    // decodeRisuSave falls back to fflate.decompressSync for headerless data.
    // Probe that same family first; invalid raw/msgpack input is allowed through
    // to the normal decoder, while successful decompression is byte-bounded.
    preflightUnknownCompressed(data);
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
    preflightRepairBackup(raw);
    return assertRepairShape(normalizeJSON(await decodeRisuSave(raw)));
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
            worker = new Worker(__filename, {
                workerData: Buffer.from(raw),
                resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
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

module.exports = { readBoundedRisuSave, MAX_REPAIR_BACKUP_BYTES, MAX_REPAIR_DECOMPRESSED_BYTES };
