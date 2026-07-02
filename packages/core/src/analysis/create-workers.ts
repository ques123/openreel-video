/**
 * Worker factories for the perception funnel.
 *
 * This is the ONLY place analysis workers are constructed. The
 * `new Worker(new URL(...), { type: "module" })` pattern lets Vite bundle
 * each worker (with mediabunny / transformers.js resolved locally) as its
 * own chunk. Keep this module out of anything unit-tested under jsdom —
 * jsdom cannot construct module workers.
 */

export function createFunnelWorker(): Worker {
  return new Worker(new URL("./workers/funnel-worker.ts", import.meta.url), {
    type: "module",
    name: "perception-funnel",
  });
}

export function createEmbeddingWorker(): Worker {
  return new Worker(new URL("./workers/embedding-worker.ts", import.meta.url), {
    type: "module",
    name: "perception-embedding",
  });
}

export function createWhisperWorker(): Worker {
  return new Worker(new URL("./workers/whisper-worker.ts", import.meta.url), {
    type: "module",
    name: "perception-whisper",
  });
}
