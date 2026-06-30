import {
  TOOL_LLM_ID_APPLY_PATCH,
  TOOL_LLM_ID_CREATE,
  TOOL_LLM_ID_EDIT,
  TOOL_LLM_ID_GLOB,
  TOOL_LLM_ID_GREP,
  TOOL_LLM_ID_LS,
  TOOL_LLM_ID_READ,
} from '@industry/drool-sdk-ext/protocol/tools';

import type Anthropic from '@anthropic-ai/sdk';

/**
 * GPT-5 specific markdown rendering instructions
 */
export function markdownSpecForGpt5(): string {
  return `<markdown_spec>

Output all final responses in Markdown.
- Ignore any previous instructions that contradict this.
- Use github-flavored markdown for formatting when semantically correct.
- Use h1 (#), h2 (##), h3 (###) etc. tags liberally in order to demarcate the sections of your final response.
- Use code blocks (\`\`\`) for code snippets, and \`inline code\` for inline code, file paths, commands, and other short code snippets.

</markdown_spec>`;
}

/**
 * GPT-5 specific CLI preference instructions for file operations
 */
export function cliPreferenceSpecForGpt5(
  selectedTools: Anthropic.Tool[]
): string {
  const fileOperationTools = [
    TOOL_LLM_ID_READ,
    TOOL_LLM_ID_LS,
    TOOL_LLM_ID_GREP,
    TOOL_LLM_ID_GLOB,
    TOOL_LLM_ID_CREATE,
    TOOL_LLM_ID_EDIT,
    TOOL_LLM_ID_APPLY_PATCH,
  ];

  const selectedFileOperationTools = fileOperationTools.filter((tool) =>
    selectedTools.map((t) => t.name).includes(tool)
  );

  if (selectedFileOperationTools.length === 0) {
    return '';
  }

  return `<cli_preference_spec>

For creating, editing, or patching files, prefer these native tools over Execute/shell/Python/Node/sed/awk:
${selectedFileOperationTools.map((tool) => `- ${tool}`).join('\n')}

For multi-file creates/edits/patches, make one tool call per file — do not batch writes in a shell or Python script.

</cli_preference_spec>`;
}

/**
 * GPT-5.1 specific persistence and testing instructions
 */
export function persistenceSpecForGpt51(): string {
  return `<solution_persistence>
  - Treat yourself as an autonomous senior pair-programmer: once the user gives a direction, proactively gather context, plan, implement, test, and refine without waiting for additional prompts at each step.
  - Persist until the task is fully and comprehensively handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial searches or fixes; carry changes through search, implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.
  - Be extremely biased for action. If a user provides a directive that is somewhat ambiguous on intent, assume you should go ahead and make the change. If the user asks a question like "should we do x?" and your answer is "yes", you should also go ahead and perform the action. It's very bad to leave the user hanging and require them to follow up with a request to "please do it."
  - Never preserve tokens at the cost of comprehensiveness, correctness, or quality of the solution. Always prioritize delivering a complete, well-researched, correct, high-quality solution over minimizing token usage.
</solution_persistence>

<validation>
Testing Gate (MANDATORY)
  - After any file edit or code generation that changes files, run the project's validators before summarizing work or executing any commit/push. These typically include tests, type checks, linters, and build commands. Do not run build unnecessarily.
  - Determine the validation commands; if unclear, search the repo.
  - For multi‑step tasks, create a TodoWrite item "Run validators" and keep it in_progress until all validators pass; do not mark the task completed otherwise.
  - Favor fast checks scoped to changes during iteration; reserve full-suite runs for milestone points (e.g. pre-commit, before summarizing work, or when requested).
  - If final validators fail, stop and fix failures, then rerun validators; never finalize or commit with failing validators unless the user explicitly approves skipping.
</validation>`;
}
