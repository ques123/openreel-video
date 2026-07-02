/**
 * Perception funnel: fully-local clip analysis (shots, motion, quality,
 * CLIP embeddings, Whisper transcript) producing cached ClipDossiers.
 *
 * NOTE: workers/* are worker entry points and are deliberately NOT exported
 * here — they are referenced only via create-workers.ts.
 */

export * from "./types";
export * from "./worker-protocol";
export * from "./shot-metrics";
export * from "./retrieval";
export * from "./dossier-cache";
export { FunnelOrchestrator, type ProgressListener } from "./funnel-orchestrator";
export {
  createFunnelWorker,
  createEmbeddingWorker,
  createWhisperWorker,
} from "./create-workers";
