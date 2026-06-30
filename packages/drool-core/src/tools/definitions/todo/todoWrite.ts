import {
  ToolExecutionLocation,
  TOOL_LLM_ID_TODO_WRITE,
} from '@industry/drool-sdk-ext/protocol/tools';

import {
  todoWriteInputSchema,
  todoWriteLlmInputSchema,
  TODO_MAX_ITEMS_LENGTH,
  TODO_ITEM_MAX_CHAR_LENGTH,
} from './schema';
import { createTool } from '../../create-tool';
import { Toolkit } from '../../enums';

export const todoWriteTool = createTool({
  id: 'todo_write',
  llmId: TOOL_LLM_ID_TODO_WRITE,
  displayName: 'Plan',
  description: `Use this tool to draft and maintain a structured todo list for the current coding session. It helps you organize multi‑step work, make progress visible, and keep the user informed about status and overall advancement.

## Limits
- Maximum ${TODO_MAX_ITEMS_LENGTH} todo items
- Maximum ${TODO_ITEM_MAX_CHAR_LENGTH} characters per todo item

## Input Format
Provide todos as a numbered multi-line string with status markers:

\`\`\`
1. [completed] First task that is done
2. [in_progress] Currently working on this
3. [pending] Not started yet
\`\`\`

Status markers: \`[completed]\`, \`[in_progress]\`, \`[pending]\`
Numbers are for readability only; item order is determined by line position.

## PERFORMANCE TIP
Call TodoWrite IN PARALLEL with other tools to save time and tokens. When starting work on a task, create/update todos simultaneously with your first exploration tools (Read, Grep, LS, etc.). Don't wait to finish reading files before creating your todo list - do both at once. This parallelization significantly improves response time.

Examples of parallel execution:
- Creating initial todo list WHILE searching for relevant files with Grep/Glob
- Updating todo status to in_progress WHILE reading the file you're about to edit

## When to Use This Tool

Use this tool proactively when:
1. Complex multi‑step work — requires 3 or more distinct actions i.e. at least 3 tool calls (not just 3 logical steps in one command)
2. Non‑trivial work — requires deliberate planning or multiple operations
3. The user asks for a todo list — explicit request to track via todos
4. The user gives multiple tasks — a numbered or comma‑separated list
5. New instructions arrive — immediately capture them as todos
6. You begin a task — set it to in_progress BEFORE you start; keep only one in_progress at a time
7. You finish a task — mark it completed only after verification, then add any follow‑ups discovered during implementation
8. You are handing back control to the user — mark all completed work as such before responding

## When NOT to Use This Tool
Skip it when:
1. There’s a single, straightforward task
2. The work is trivial and tracking adds no value
3. It can be done in fewer than 3 trivial steps. If a task needs 1-2 tool calls altogether, skip TodoWrite.
4. The request is purely conversational or informational
5. Do NOT create todos based on system context, environment outputs, or your interpretation of what might need doing, only user's explicitly given tasks.
NOTE: If there’s only one trivial task, do it directly rather than creating a list.

## Examples of When to Use the Todo List
<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: I’ll add a dark mode toggle. I’ll create a todo list to track this.
*Creates todos:*
1. Add dark mode toggle on Settings page
2. Add dark mode state management (context/store)
3. Implement CSS‑in‑JS styles for dark theme
4. Update components to support theme switching
5. Run tests and build; fix any failures
*Begins task 1*
<reasoning>
Why a todo list:
1. Multi‑step feature: UI, state, styling
2. The user explicitly asked to run tests/build afterward
3. The assistant added an “Ensure tests/build succeed” step to reflect the requirement
</reasoning>
</example>

<example>
User: Help me rename getCwd to getCurrentWorkingDirectory across my project
Assistant: I’ll first search for all occurrences of getCwd.
*Searches/greps the repo*
Assistant: Found 15 occurrences across 8 files. I’ll create todos to track these edits.
*Creates items per file to update*
<reasoning>
Why a todo list:
1. Initial search clarified scope
2. Multiple files/occurrences make this a multi‑step task
3. Todos ensure each location is updated systematically
4. Prevents misses and preserves consistency
</reasoning>
</example>

<example>
User: I need features for my e‑commerce site: user registration, product catalog, shopping cart, checkout flow.
Assistant: I’ll break these down into todos first.
*Creates a list with task breakdowns for each feature per the project architecture*
Assistant: Starting with user registration: database models, API endpoints, and frontend forms integrated with the auth system.
<reasoning>
Why a todo list:
1. Multiple complex features provided in a single list
2. Breaks large work into actionable steps
3. Enables tracking progress across the full implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React app? It renders slowly.
Assistant: I’ll analyze the codebase for bottlenecks, then create a todo list for fixes.
*Reviews components, render patterns, state, and data fetching*
*Creates todos such as: 1) Memoize expensive calcs in ProductList, 2) Virtualize long lists in Dashboard, 3) Optimize image loading in Gallery, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and add code splitting*
Let’s start with memoization in ProductList.
<reasoning>
Why a todo list:
1. Analysis reveals multiple optimization opportunities
2. Perf work is non‑trivial and multi‑step
3. Todos help methodically improve several components
4. Ensures all bottlenecks get addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List
<example>
User: How do I print 'Hello World' in Python?
Assistant: Use:
python
print("Hello World")
This prints the line to the console.
<reasoning>
No todo list: a single trivial step with no need for tracking.
</reasoning>
</example>

<example>
User: What does git status do?
Assistant: It shows the working directory and staging area state, including staged/unstaged changes and untracked files. Useful before commits.
<reasoning>
No todo list: informational only, not a multi‑step coding task.
</reasoning>
</example>

<example>
User: Add a comment to calculateTotal explaining what it does.
Assistant: Sure — I’ll add the comment now.
* Uses the Edit tool to add the comment *
<reasoning>
No todo list: a single, focused edit in one place.
</reasoning>
</example>

<example>
User: Run npm install and report the result.
Assistant: Running npm install…
*Executes: npm install*
Completed successfully. All dependencies installed per package.json.
<reasoning>
No todo list: one command with immediate output; no steps to organize.
</reasoning>
</example>

<example>
User: First run "npm run lint:fix", then execute "pytest tests/ -v --cov=src", and finally "docker build -t myapp:latest ."
Assistant: I'll track these exact commands and start working on them.
*IN PARALLEL: Creates todos AND starts executing first command*
Todos:
1. Run: npm run lint:fix
2. Run: pytest tests/ -v --cov=src
3. Run: docker build -t myapp:latest .
<reasoning>
Why this approach:
1. TodoWrite called simultaneously with Execute tool for first command, since this requires at least 3 tool calls.
2. [IMPORTANT] We need to preserve the exact commands as given by user with all flags and arguments
3. Parallel execution saves time vs sequential todo→execute pattern
4. User's specific instructions captured verbatim for accurate execution
</reasoning>
</example>

## Task States and Management
1. Task states:
   - pending: not started
   - in_progress: currently working (limit to ONE at a time)
   - completed: finished
2. Task management:
   - Update status in real time while working
   - Mark items completed IMMEDIATELY after finishing (don’t batch)
   - Mark items completed ONLY after you've actually performed the work (executed tools, made changes). Never mark completed based on plans or intentions.
   - Keep only ONE in_progress at any moment
   - Finish current work before starting another
   - Remove items that become irrelevant
   - When calling TodoWrite in parallel with action tools, mark the first item in_progress - parallel execution means work has started.
   - Keep exactly ONE in_progress item when actively working.
3. Completion rules:
   - Mark completed ONLY when FULLY done and verified.
   - Update immediately after finishing each item.
   - If errors/blockers remain, keep it in_progress
   - When blocked, add a new task describing the blocker/resolution
   - Never mark completed if:
     - Tests fail
     - Implementation is partial
     - Errors are unresolved
     - Required files/dependencies are missing
4. Task breakdown:
   - Write specific, actionable items
   - Split complex work into smaller steps
   - Use clear, descriptive names
   - **Preserve exact user instructions**: When users provide specific commands or steps, capture them verbatim
   - Include CLI commands exactly as given (e.g., "Run: npm test --coverage --watch=false")
   - Maintain user-specified flags, arguments, and order of operations

**CRITICAL**: If your todo list has ANY [pending] items, you MUST have EXACTLY ONE [in_progress] item. When all work is complete and only a "waiting for user" item remains, mark it [in_progress] (not [pending]), or remove the todo list entirely.

When uncertain, err on the side of using this tool. Proactive task tracking shows diligence and helps ensure all requirements are met.`,
  executionLocation: ToolExecutionLocation.Client,
  isTopLevelTool: true,
  requiresConfirmation: false,
  inputSchema: todoWriteInputSchema,
  llmInputSchema: todoWriteLlmInputSchema,
  isVisibleToUser: false,
  sideEffects: [],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
