/**
 * Perception funnel: fully-local clip analysis (shots, motion, quality,
 * SigLIP2 embeddings, VLM captions, Whisper transcript) producing cached
 * ClipDossiers.
 *
 * NOTE: workers/* are worker entry points and are deliberately NOT exported
 * here — they are referenced only via create-workers.ts.
 */

export * from "./types";
export * from "./worker-protocol";
export * from "./shot-metrics";
export * from "./retrieval";
export * from "./dossier-cache";
export * from "./caption-text";
export * from "./style-presets";
export * from "./footage-digest";
export * from "./cloud-vision-plan";
export * from "./extract-audio";
export * from "./vad-regions";
export * from "./audio-signal";
export * from "./signal-score";
export * from "./cloud-stt-plan";
export * from "./music-prompt";
export * from "./director-types";
export * from "./director-prompt";
export * from "./storyboard";
export * from "./director-loop";
export * from "./compile-timeline";
export { FunnelOrchestrator, type ProgressListener } from "./funnel-orchestrator";
export {
  createFunnelWorker,
  createEmbeddingWorker,
  createWhisperWorker,
} from "./create-workers";
