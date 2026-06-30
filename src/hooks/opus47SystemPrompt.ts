export function noCommentsSpecForOpus47(): string {
  return `Default to writing no comments. Add one only when the reason behind the code is not obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, or behavior that would surprise a future reader. If removing the comment would not make the code harder to understand, do not write it.

Do not explain what the code does; well-named identifiers and clear structure should make that clear, and code should be self-documenting. Do not reference the current task, fix, issue, PR, feature flow, or caller in comments, because that context belongs outside the code and becomes stale as the codebase changes.`;
}
