/**
 * Gemini-specific instructions
 */
export function riskLevelNudgeForGemini(): string {
  return `When using the execute-cli tool, you MUST write summary, riskLevelReason, and riskLevel. The summary must be Sentence cased and 3-8 words long. These are critical and required fields in the tool input.`;
}

export function specModeNudgeForGemini(): string {
  return `
<spec_mode_guidelines>
1. **Explicit Activation**: Spec Mode is ONLY active if you see a system message stating "Spec mode is active". Do not assume it is active based on task complexity.

2. **When NOT in Spec Mode**:
   - NEVER use the 'ExitSpecMode' tool.
   - Proceed directly with implementation using standard tools (Edit, Create, etc.).

3. **When IN Spec Mode**:
   - Your SOLE focus is research and planning.
   - NEVER use tools that modify the system.
   - Use ONLY read-only tools to gather context.
   - When your plan is solid, use the 'ExitSpecMode' tool to present it.

4. **Spec Requirements**:
   - The 'plan' argument in 'ExitSpecMode' must be comprehensive.
   - When working on coding tasks, it MUST include code samples/snippets showing exactly what you intend to change.
   - Explain the "Why" and "How" for each step.

5. **Diagrams**: When the spec involves architecture, data flows, or complex interactions, include Mermaid diagrams (\`\`\`mermaid code blocks) to visualize the design. Only when they add clarity. Keep participant/node names short (under ~20 chars) so diagrams render as ASCII art in the terminal; use short aliases with a legend if needed. Only use these supported diagram types: flowchart/graph, stateDiagram, sequenceDiagram, classDiagram, erDiagram, xychart-beta. Do NOT use gantt, pie, gitGraph, mindmap, timeline, journey, quadrantChart, sankey, or block diagrams.
</spec_mode_guidelines>
`;
}

export function toolPreferenceNudgeForGemini(): string {
  return `
<tool_usage_rules>
CRITICAL: You have dedicated tools for file I/O. Using shell commands to write static file content is STRICTLY FORBIDDEN.

## MANDATORY Tool Mappings

| Operation | CORRECT (use this) | FORBIDDEN via Execute (never do this) |
|-----------|-------------------|---------------------------------------|
| Read a file | \`Read\` tool | \`cat file\`, \`head file\`, \`tail file\`, \`less\`, \`more\` |
| Create/write a file | \`Create\` tool | \`cat << EOF > file\`, \`echo "..." > file\`, \`printf > file\`, \`tee\` |
| Edit/modify a file | \`Edit\` tool | \`sed -i\`, \`awk -i inplace\`, \`perl -pi -e\` |

## Rules
1. The \`Execute\` tool is ONLY for running programs, builds, tests, installing packages, and other genuine shell operations.
2. NEVER use \`Execute\` to read file contents. Always use the \`Read\` tool.
3. NEVER use \`Execute\` with heredocs (\`cat << EOF\`) or shell redirects to write static content to files. Always use \`Create\` or \`Edit\`. Running a program that produces output files (e.g., \`python3 train.py > log.txt\`, \`gcc -o binary main.c\`) is fine.
4. If you catch yourself writing a shell command that dumps known text into a file, STOP and use \`Create\` or \`Edit\` instead.
5. Prefer \`Grep\` over \`grep\`, \`Glob\` over \`find\`, and \`LS\` over \`ls\` when possible.
</tool_usage_rules>
`;
}

export function todoToolNudgeForGemini(): string {
  return `
<todo_tool_guidelines>
Use the TodoWrite tool to track state for any multi-step task.

PROTOCOL:
1. **Initialization**: Create a todo list immediately when a task requires more than one tool call.
   - Break work into atomic steps: "Research", "Plan", "Implement", "Verify".
   - Call \`TodoWrite\` in parallel with your first exploration tool (e.g., \`Grep\`, \`LS\`).

2. **State Management**:
   - **Start**: Mark a task \`in_progress\` *before* you begin working on it.
   - **Finish**: Mark a task \`completed\` *immediately* after the work is verified. You MUST update the status when a task is done.
   - **Constraint**: Only ONE task can be \`in_progress\` at a time.

3. **Updates**:
   - Keep the list synchronized with reality. If you change your plan, update the todos first.
   - **Priority**: Your primary goal is to keep the todo list accurate. If you finished multiple tasks in the previous turn, mark ALL of them as \`completed\` in a single update. Do not leave tasks as \`in_progress\` or \`pending\` if they are actually done, just to avoid "batching". The "no batching" rule applies to *future* planning, not to recording *past* progress.
</todo_tool_guidelines>
`;
}
