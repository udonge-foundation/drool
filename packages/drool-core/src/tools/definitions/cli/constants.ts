/**
 * Supported image MIME types for the Read tool.
 * These are the image formats that can be processed and returned as Anthropic content blocks.
 */
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

/**
 * Maximum file size for image processing (5MB)
 */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Supported PDF MIME types for the Read tool.
 */
export const SUPPORTED_PDF_TYPES = ['application/pdf'] as const;

/**
 * Maximum file size for PDF processing (3MB).
 * Limited by Vercel's 4.5MB request body size limit for the LLM proxy.
 * Base64 encoding inflates ~33%, so 3MB raw -> ~4MB base64, leaving room
 * for conversation context in the request body.
 */
export const MAX_PDF_SIZE_BYTES = 3 * 1024 * 1024; // 3MB

/**
 * Maximum number of pages allowed in a PDF for native provider support.
 * Anthropic limits PDF documents to 100 pages maximum.
 * PDFs exceeding this limit will fall back to text extraction.
 */
export const MAX_PDF_PAGES = 100;

export const EXECUTE_CLI_TOOL_ID = 'execute-cli';

export const UPGRADE_SESSION_MODEL_TOOL_ID = 'upgrade-session-model-cli';

export const DEFAULT_TASK_TOOL_DESCRIPTION = `Launch a new subagent (custom drool) to handle a complex, multi-step task autonomously.

  Required inputs:
  - subagent_type: the drool name/identifier (example: "worker"). Only invoke subagents that appear in the available list — do not guess or invent identifiers.
  - description: a short 3–5 word label for the UI
  - prompt: the full task to execute

  Where to find available drools:
  - ~/.industry/drools (personal)
  - .industry/drools (project)

  Capabilities:
  - The subagent can only use the tools enabled by its drool configuration. If you need code edits, choose a drool that enables file-editing tools.
  - Each invocation is stateless and returns a single final report (no follow-up questions).

  When NOT to use the Task tool:
  - If you want to read a specific file path, use the Read tool
  - If you are searching for a specific class definition like "class Foo", use the Grep/Glob tools
  - If you are working within 1-10 known files, use the file tools directly instead of spawning a subagent

  How to write a good prompt (template):
  1. Goal:
  2. Context (repo paths / commands / links):
  3. Constraints (what to avoid / must preserve):
  4. Questions to answer or steps to take:
  5. Expected output format (e.g. file paths + summary, patch, checklist):

  Define the output shape in your prompt: tell the subagent exactly what to return and in what format. Be explicit.

  Usage notes:
  1. If you need parallel subagents, issue multiple Task tool calls in the same assistant message.
  2. When the subagent is done, it returns a single message to you. The result is not shown to the user unless you summarize it.
  3. Clearly tell the subagent whether you expect it to write code or only do research, and specify exactly what it should return.`;

export const DEFAULT_TASK_TOOL_DESCRIPTION_V2 = `Launch a new subagent to handle a complex, multi-step task autonomously.

  Required inputs:
  - subagent_type: the drool name/identifier (example: "worker"). Only invoke subagents that appear in the available list -- do not guess or invent identifiers.
  - description: a short 3-5 word label for the UI
  - prompt: the full task to execute

  Optional inputs:
  - complexity: optional task complexity tier (light|medium|heavy). When set, Task model selection follows your configured complexity→model routing.
  - run_in_background: set to true to run async. Returns immediately with a task_id. You will be notified when it completes.
  - resume: task_id (session ID) from a previous Task invocation to resume with full context preserved.

  Built-in subagent types:
  - "worker": General-purpose agent with full tool access
  - "explorer": Fast read-only agent for codebase exploration

  When NOT to use the Task tool:
  - If you want to read a specific file path, use the Read tool
  - If you are searching for a specific class definition like "class Foo", use the Grep/Glob tools
  - If you are working within 1-10 known files, use the file tools directly instead of spawning a subagent

  How to write a good prompt (template):
  1. Goal:
  2. Context (repo paths / commands / links):
  3. Constraints (what to avoid / must preserve):
  4. Questions to answer or steps to take:
  5. Expected output format (e.g. file paths + summary, patch, checklist):

  Define the output shape in your prompt: tell the subagent exactly what to return and in what format. Be explicit.

  Usage notes:
  1. If you need parallel subagents, issue multiple Task tool calls in the same assistant message.
  2. When the subagent is done, it returns a single message to you. The result is not shown to the user unless you summarize it.
  3. Clearly tell the subagent whether you expect it to write code or only do research, and specify exactly what it should return.
  4. Built-in subagents use default complexities if you omit complexity: worker=medium, explorer=light.
  5. Use run_in_background=true when you have genuinely independent work to do in parallel.
  6. Use resume with a previous task_id to continue a subagent's work with its full prior context preserved.

  Background task workflow:
  - After launching with run_in_background=true, you get a task_id back.
  - IMPORTANT: Use the TaskOutput tool with block=true to wait for and retrieve the result. Do NOT tell the user you will notify them later -- fetch the result yourself.
  - Use TaskOutput with block=false to check progress without waiting.
  - Use TaskStop to kill a running background task.`;
