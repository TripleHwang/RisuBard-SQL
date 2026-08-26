'use strict';

function waitForDrain(response, signal) {
  if (response.writableEnded || response.destroyed || signal?.aborted) return Promise.reject(new Error('NDJSON response closed'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.removeListener('drain', onDrain); response.removeListener('close', onClose); signal?.removeEventListener('abort', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('NDJSON response closed')); };
    response.once('drain', onDrain); response.once('close', onClose); signal?.addEventListener('abort', onClose, { once: true });
  });
}

/**
 * Bounded writer for long-running NDJSON responses. Progress is a single
 * latest-value slot; heartbeats are dropped while output is backed up. Final
 * records wait for the latest progress record and socket drain.
 */
function createNdjsonResponseWriter(response, options = {}) {
  const throttleMs = Number.isFinite(options.throttleMs) ? Math.max(0, options.throttleMs) : 250;
  const signal = options.signal;
  let pendingProgress = null;
  let progressTimer = null;
  let pumping = null;
  let heartbeatWrite = null;

  const writable = () => !response.writableEnded && !response.destroyed && !signal?.aborted;
  const write = async record => {
    if (!writable()) throw new Error('NDJSON response closed');
    if (!response.write(JSON.stringify(record) + '\n')) await waitForDrain(response, signal);
  };
  const pump = () => {
    if (pumping) return pumping;
    pumping = (async () => {
      if (heartbeatWrite) { try { await heartbeatWrite; } catch {} }
      while (pendingProgress) {
        const record = pendingProgress;
        pendingProgress = null;
        await write(record);
      }
    })().finally(() => { pumping = null; if (pendingProgress && !progressTimer) progressTimer = setTimeout(flushScheduled, throttleMs); });
    return pumping;
  };
  const flushScheduled = () => { progressTimer = null; void pump().catch(() => {}); };
  return {
    progress(record) {
      if (!writable()) return;
      pendingProgress = record;
      if (record?.terminal === true) {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = null;
        void pump().catch(() => {});
      } else if (!progressTimer && !pumping) progressTimer = setTimeout(flushScheduled, throttleMs);
    },
    heartbeat() {
      if (!writable() || pendingProgress || pumping || heartbeatWrite) return;
      heartbeatWrite = write({ type: 'heartbeat' }).catch(() => {}).finally(() => { heartbeatWrite = null; });
    },
    async flush() {
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      if (heartbeatWrite) await heartbeatWrite;
      while (pendingProgress || pumping) await pump();
    },
    async final(record) { await this.flush(); await write(record); },
    close() { if (progressTimer) clearTimeout(progressTimer); progressTimer = null; pendingProgress = null; },
  };
}

module.exports = { createNdjsonResponseWriter };
