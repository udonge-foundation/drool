import { TOOL_LLM_ID_APPLY_PATCH } from '@industry/drool-sdk-ext/protocol/tools';

const OPENAI_APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION =
  'Create a new file or edit an existing file using structured diffs in the Lark grammar. Does NOT allow file moving or deletion. Does NOT allow multi-file edits within single tool call.';

const OPENAI_APPLY_PATCH_LARK_GRAMMAR_DEFINITION = `start: begin_patch hunk end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
update_hunk: "*** Update File: " filename LF change

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export function isApplyPatchToolName(name: string): boolean {
  return name === TOOL_LLM_ID_APPLY_PATCH;
}

export function normalizeApplyPatchToolName(name: string): string {
  return isApplyPatchToolName(name) ? TOOL_LLM_ID_APPLY_PATCH : name;
}

export function getApplyPatchInputFromParameters(
  parameters: Record<string, unknown>
): string {
  const input = parameters.input;
  return typeof input === 'string' ? input : '';
}

export function getOpenAIApplyPatchCustomToolDescription(): string {
  return OPENAI_APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION;
}

export function getOpenAIApplyPatchCustomToolFormat(): {
  type: 'grammar';
  syntax: 'lark';
  definition: string;
} {
  return {
    type: 'grammar',
    syntax: 'lark',
    definition: OPENAI_APPLY_PATCH_LARK_GRAMMAR_DEFINITION,
  };
}
