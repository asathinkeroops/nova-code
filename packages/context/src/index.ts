export {
  loadMemory,
  MEMORY_INDEX_FILENAME,
  type MemoryBundle,
  type MemoryLayer,
  type MemorySource,
  type LoadMemoryOptions,
} from "./memory.js";

export {
  COMPACT_MARKER,
  isCompactionMarker,
  sliceFromLastCompacted,
  estimateTokens,
  computeThreshold,
  shouldAutoCompact,
  autoCompact,
  type ThresholdOptions,
  type AutoCompactOptions,
  type AutoCompactResult,
} from "./compact.js";
