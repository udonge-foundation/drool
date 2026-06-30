export const APPLY_PATCH_INCOMPLETE_INPUT_LLM_ERROR =
  'ApplyPatch requires a non-empty patch body in the `input` field. The tool call may have arrived without its patch payload. Retry ApplyPatch with the complete patch text.';

export const APPLY_PATCH_INCOMPLETE_INPUT_USER_ERROR =
  'ApplyPatch requires a complete patch body';
