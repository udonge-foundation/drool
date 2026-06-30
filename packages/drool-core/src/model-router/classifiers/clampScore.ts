/**
 * Clamp a raw classifier-emitted score into the [0, 1] range used by
 * the selector. Deduped between {@link TaskClassifier} (post-API
 * assembly) and {@link parseTaskClassifierResponse} (pre-validation
 * normalization) so the two paths can never disagree.
 */
export function clampScore(raw: number): number {
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}
