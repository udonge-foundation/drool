export function getStatusBannerHint(params: {
  isRewindProcessing: boolean;
  isInterruptPending: boolean;
}): string {
  return params.isRewindProcessing || params.isInterruptPending
    ? '(Please wait)'
    : '(Press ESC to stop)';
}
