import fileBufferUrl from './rpack_map.bin?url';

let mapData;
let encodeMap;
let decodeMap;

export async function initRPack() {
    if(mapData) return; // Already initialized
    const response = await fetch(fileBufferUrl);
    const arrayBuffer = await response.arrayBuffer();
    mapData = new Uint8Array(arrayBuffer);
    encodeMap = mapData.slice(0, 256);
    decodeMap = mapData.slice(256, 512);
}

export async function encodeRPack(data) {
    await initRPack();
    let result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = encodeMap[data[i]];
    }
    return result;
}
export async function decodeRPack(data) {
    await initRPack();
    let result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = decodeMap[data[i]];
    }
    return result;
}

export function getRPackWorkerCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 1) {
    const availableCores = Math.max(1, Math.floor(Number(hardwareConcurrency) || 1));
    return Math.min(8, Math.max(1, availableCores - 1));
}

export class RPackDecoderPool {
    constructor(size, createWorker) {
        this.createWorker = createWorker;
        this.queue = [];
        this.nextId = 1;
        this.terminated = false;
        this.slots = Array.from({ length: Math.max(1, size) }, () => this.createSlot());
    }

    createSlot() {
        const slot = {
            worker: this.createWorker(),
            current: null,
        };
        slot.worker.onmessage = (event) => this.handleMessage(slot, event);
        slot.worker.onerror = (event) => this.handleError(slot, event);
        return slot;
    }

    decodeAll(items) {
        return Promise.all(items.map((item) => this.decode(item)));
    }

    decode(data) {
        if (this.terminated) {
            return Promise.reject(new Error('RPack decoder pool has been terminated'));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ id: this.nextId++, data, resolve, reject });
            this.dispatch();
        });
    }

    dispatch() {
        for (const slot of this.slots) {
            if (slot.current || this.queue.length === 0) continue;
            const job = this.queue.shift();
            const input = job.data.slice();
            slot.current = job;
            slot.worker.postMessage({ id: job.id, data: input.buffer }, [input.buffer]);
        }
    }

    handleMessage(slot, event) {
        const job = slot.current;
        if (!job || event.data?.id !== job.id) return;
        slot.current = null;
        if (event.data.error) {
            job.reject(new Error(event.data.error));
        } else {
            job.resolve(new Uint8Array(event.data.data));
        }
        this.dispatch();
    }

    handleError(slot, event) {
        const job = slot.current;
        slot.current = null;
        job?.reject(event.error ?? new Error(event.message || 'RPack worker failed'));
        slot.worker.terminate();
        if (!this.terminated) {
            const replacement = this.createSlot();
            const index = this.slots.indexOf(slot);
            if (index >= 0) this.slots[index] = replacement;
        }
        this.dispatch();
    }

    terminate() {
        this.terminated = true;
        const error = new Error('RPack decoder pool has been terminated');
        for (const job of this.queue.splice(0)) job.reject(error);
        for (const slot of this.slots) {
            slot.current?.reject(error);
            slot.current = null;
            slot.worker.terminate();
        }
    }
}

let sharedDecoderPool;

function getSharedDecoderPool() {
    if (!sharedDecoderPool) {
        sharedDecoderPool = new RPackDecoderPool(
            getRPackWorkerCount(),
            () => new Worker(new URL('./rpack_worker.js', import.meta.url), { type: 'module' }),
        );
    }
    return sharedDecoderPool;
}

export async function decodeRPackBatch(items) {
    if (items.length === 0) return [];
    if (typeof Worker === 'undefined') {
        return Promise.all(items.map((item) => decodeRPack(item)));
    }
    try {
        return await getSharedDecoderPool().decodeAll(items);
    } catch {
        return Promise.all(items.map((item) => decodeRPack(item)));
    }
}
