/**
 * Default window of items shown in the anchored transcript slice. Ink renders
 * each message bounded by its own layout, so keeping this small keeps the
 * non-Static render path fast while still giving enough context around the
 * selected turn.
 */
export const DEFAULT_TRANSCRIPT_ANCHOR_SLICE_SIZE = 12;
