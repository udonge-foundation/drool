import {
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import { SettingsManager } from '@industry/runtime/settings';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import type { SkillCreatorMessageComponents } from '@/hooks/skill-creation/types';
import { getI18n } from '@/i18n';

/**
 * Generates the skill creator message components.
 * Returns both a user-visible opening line and the full message with hidden instructions.
 */
export async function getSkillCreatorMessage(
  description: string
): Promise<SkillCreatorMessageComponents> {
  const industryDir = `${getIndustryHome()}/${getIndustryDirName()}`;
  const sessionsDir = `${industryDir}/sessions`;
  const personalSkillsDir = `${industryDir}/skills`;
  const projectSkillsDir = `${getIndustryDirName()}/skills`;

  // Load existing skills list
  const settings = await SettingsManager.getInstance().getResolvedSettings();
  const allSkills = settings.skills ?? [];
  const skillsList =
    allSkills
      .filter((s) => s.validationResult.valid)
      .map((s) => `- ${s.filePath}`)
      .join('\n') || 'No existing skills found.';

  // User-visible opening line (truncate long descriptions)
  const truncatedDesc =
    description.length > 60
      ? `${description.substring(0, 60)}...`
      : description;
  const openingLine = getI18n().t(
    'commands:slashMessages.createSkill.creatingSkill',
    {
      description: truncatedDesc,
    }
  );

  // Block 1: Instructions (SYSTEM_NOTIFICATION - hidden from UI)
  const instructions = `# Skill Creation Task

Clear all previous plans and todos. Your previous task is complete. Your new task is to create a reusable skill.

## User Request
${description}

**Before starting, create a todo list from the steps below.**

**IMPORTANT: You MUST complete every step thoroughly. Do not skip steps. Do not skim. Superficial research produces worthless skills.**

Your job is to deeply understand this workflow. The skill file is just documentation of what you learned.

## Resources
- **Project skills directory**: \`${projectSkillsDir}/\`
- **Personal skills directory**: \`${personalSkillsDir}/\`
- **Session history**: \`${sessionsDir}/\` (JSONL files)

---

# Phase 1: Research (This is the real work)

## 1. Understand the Skill Format
Study the "Skills Documentation Reference" provided in context to understand the file format and best practices.

You MUST understand this before proceeding. Do not skip this.

## 2. Check Existing Skills
Review the "Existing Skills" list provided in context. READ the most relevant skills (up to 5) to understand the format and conventions used.

If an existing skill already covers this use case, STOP and explain how to use it instead.

## 3. Evaluate if a Skill is Appropriate
**Good for a skill**: Repeatable workflows, common patterns, tasks done across multiple sessions
**Not ideal**: One-off tasks, highly variable tasks that differ each time

If the task seems too specific or one-off, suggest alternatives (document it, wait for the pattern to repeat).

## 4. Analyze the Current Conversation
What workflow was performed? What steps were taken? What was the outcome?

**WARNING: The current session is ONE example. Do not anchor on it. You MUST find DIFFERENT examples in the next step.**

## 5. Search Broadly for All Variations

**CRITICAL: Do not extrapolate from the current session alone. Do not fabricate findings.**

### 5a. Search Relevant Knowledge Sources
Identify and search knowledge sources relevant to this workflow:
- If codebase-related: search for all places this pattern applies
- If tool-related: read the tool's documentation
- If API-related: fetch and read the API docs
- If domain-specific: find authoritative references

Show your search commands and results.

### 5b. Search Past Sessions
Search \`${sessionsDir}/\` for sessions where similar tasks were performed.

You MUST:
1. Grep to find matching sessions (try multiple search terms)
2. When you find relevant sessions, READ their content - do not just list filenames and move on
3. Extract specific learnings: what worked, what failed, what varied between sessions
4. Quote specific evidence from what you read to support your findings

### 5c. Document Your Findings (REQUIRED)

Before proceeding, you MUST produce ALL of the following with **quoted evidence**:

| Finding | Your Answer (with quotes/citations) |
|---------|-------------------------------------|
| **Sessions found** | List session files you searched and which were relevant |
| **What went wrong** | Quote specific problems or friction from past sessions |
| **What varied** | Show how the workflow differed across instances |
| **Edge cases** | List unusual situations the skill must handle |

**If you cannot fill this table with real evidence, STOP and tell the user you need more information. Do not proceed with fabricated findings.**

---

# Phase 2: Synthesize (Document what you learned)

## 6. Choose Location
**Project skill** (\`${projectSkillsDir}/\`): Repo-specific workflows - team conventions, project-specific tools, codebase patterns. Shared with teammates via git.
**Personal skill** (\`${personalSkillsDir}/\`): General workflows that apply across any project - your preferences, cross-project patterns. Private to your machine.

## 7. Propose Your Skill
Before creating any files, present:
- Your findings from Phase 1 (with the evidence table from step 5c)
- What the skill will do
- How it handles each edge case you found
Your spec MUST be thorough, detailed, and specific.

**A skill is a directory.** Scripts, schemas, and other files can be central to the skill's value. SKILL.md defines the workflow, whether that's step-by-step instructions or orchestration of automation. You MUST seriously consider what belongs in the directory:
- Scripts (\`*.sh\`, \`*.py\`) - Can be the core of the skill (query APIs, process data, generate reports)
- Environment setup (\`requirements.txt\`, \`.env.template\`, \`.gitignore\`, etc.) - Dependencies and configuration
- Schemas - Structured inputs
- Checklists - Verification steps
- References - Pointers to relevant code/docs

What would make this skill maximally useful? What would make this skill more useful and consistent when invoked repeatedly? Explain what you will or won't include and why.

## 8. Create the Skill
Write the skill following the format from the documentation. The skill MUST adhere to the structure and guidelines in the docs.

If your skill includes scripts that require environment setup (dependencies, credentials, API keys), ask the user what configuration is needed and document prerequisites in SKILL.md.

## Output
Create a skill directory at the appropriate location. A skill is a **directory**, not just a file:

**Required:**
- \`SKILL.md\` - Main skill specification with YAML frontmatter

**Other contents:**
- Scripts (\`*.sh\`, \`*.py\`) - Automation (can be the core of the skill)
- Environment setup (\`requirements.txt\`, \`.env.template\`, etc.) - Dependencies and configuration
- \`schemas/\` - JSON/YAML schemas for structured inputs
- \`checklists.md\` - Rollout or verification checklists
- \`references.md\` - Links to relevant code, APIs, or docs

Locations:
- Project: \`${projectSkillsDir}/<skill-name>/SKILL.md\`
- Personal: \`${personalSkillsDir}/<skill-name>/SKILL.md\`

After creation, suggest how to test it: "You can test this skill by running /skills to see it listed, then invoke it on a similar task."`;

  // Block 2: Skills documentation reference (SYSTEM_REMINDER - separate from instructions)
  const docsReference = `${SYSTEM_REMINDER_START}
## Skills Documentation Reference

### What is a Skill?
A skill is a **directory** (e.g. \`.industry/skills/my-skill/\`) containing:
- \`SKILL.md\` or \`skill.mdx\` with YAML frontmatter and markdown instructions
- Optional supporting files (scripts, schemas, checklists)

### Skill File Format
Skills are defined in Markdown with YAML frontmatter:

\`\`\`markdown
---
name: summarize-diff
description: Summarize the staged git diff in 3-5 bullets. Use when the user asks for a summary of pending changes.
---

# Summarize Diff

## Instructions

1. Run \`git diff --staged\`.
2. Summarize the changes in 3-5 bullets, focusing on user-visible behavior.
3. Call out any migrations, risky areas, or tests that should be run.
\`\`\`

Key frontmatter fields: \`name\` and \`description\` help Drools discover and use the skill.

### Writing effective \`description\` values
The frontmatter \`description\` is used for Skill discovery/selection. Keep it concise and focused on **what the Skill does** and **when to use it**.

- Write in **third person**.
- Include **triggers/contexts** (keywords a user might say).
- Keep it to **1–2 sentences**.
- Do **not** put step-by-step procedures, checklists, or arrow sequences in \`description\`. Put those in the SKILL.md body under **Instructions**.

Good:
\`description: Investigate production errors from logs and stack traces. Use when the user reports incidents, exceptions, or elevated error rates.\`

Bad:
\`description: Debug prod error → minimal fix → verification.\`

### Where Skills Live
| Scope | Location | Purpose |
|-------|----------|---------|
| **Project** | \`<repo>/.industry/skills/<skill-name>/SKILL.md\` | Repo-specific, shared with teammates via git |
| **Personal** | \`~/.industry/skills/<skill-name>/SKILL.md\` | Private skills that follow you across projects |

### Skill Directory Contents
A skill directory can contain:
- \`SKILL.md\` - Workflow instructions (required)
- Scripts (\`*.sh\`, \`*.py\`) - Automation (can be the core of the skill)
- Environment setup (\`requirements.txt\`, \`.env.template\`, etc.) - Dependencies and configuration
- \`schemas/\` - JSON/YAML schemas for structured inputs
- \`checklists.md\` - Validation or rollout checklists
- \`references.md\` - Links to types, APIs, modules in your codebase

### Best Practices

**Keep each skill narrow and outcome-focused**
Design skills around a single responsibility (e.g., "implement a typed React UI for an existing endpoint"), not "build the whole feature". Define a crisp success criterion: what artifacts should exist when the skill finishes. Prefer several small skills composed by a Drool over one giant "do everything" skill.

**Make inputs explicit and structured**
Document required inputs: repo path, services involved, APIs, schemas, feature flag names, etc. Use structured fields (JSON snippets, bullet lists, tables) instead of long prose. For security-sensitive workflows, include explicit "never do" constraints.

**Encode team conventions and guardrails**
Bake in your testing, observability, and rollout requirements so the skill always follows them. Reference your existing AGENTS.md, runbooks, and design docs instead of inlining everything. Require proof artifacts: tests, screenshots, log queries, or links to dashboards.

**Design for enterprise constraints**
Assume large monorepos, multiple services, and layered approvals. Be explicit about which directories Drools may touch, which languages/frameworks are in-bounds. Include guidance for cross-team dependencies.

**Make skills composable**
Prefer idempotent skills: safe to rerun on the same branch/PR. Design skills to produce machine-parseable output where possible. Keep skills stateless beyond the current branch.

**Operate with verification and safety**
Always include a "Verification" section that lists commands Drools must run before completing. Call out fallbacks when verification fails. For production-adjacent skills, require that Drools open PRs but never merge without human review.
${SYSTEM_REMINDER_END}`;

  // Block 3: Existing skills list content
  const skillsListBlockContent = `${SYSTEM_REMINDER_START}
## Existing Skills
${skillsList}
${SYSTEM_REMINDER_END}`;

  // Instructions message wrapped in SYSTEM_NOTIFICATION (main message to runAgent)
  const instructionsMessage = `${SYSTEM_NOTIFICATION_START}
${instructions}
${SYSTEM_NOTIFICATION_END}`;

  // Build reference blocks as proper TextBlocks
  const referenceBlocks: Array<{
    type: typeof MessageContentBlockType.Text;
    text: string;
  }> = [
    { type: MessageContentBlockType.Text, text: docsReference },
    { type: MessageContentBlockType.Text, text: skillsListBlockContent },
  ];

  return {
    openingLine,
    instructionsMessage,
    referenceBlocks,
  };
}

// eslint-disable-next-line industry/constants-file-organization
export const createSkillCommand: SlashCommand = {
  name: 'create-skill',
  description: 'Create a reusable skill from the current session',
  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;
    const description = (rawArgs ?? args.join(' ')).trim();

    // Preferred TUI flow: always open the guided overlay (even when description is empty).
    if (context.showCreateSkillFlow) {
      Metrics.addToCounter(Metric.SKILL_CREATE_COMMAND_INVOKED_COUNT, 1);
      context.showCreateSkillFlow(description);
      return { handled: true };
    }

    if (!description) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.createSkill.usage'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    // Fallback if confirmation UI is not available
    addEphemeralSystemMessage(
      getI18n().t('commands:slashMessages.createSkill.notAvailable'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );
    return { handled: true };
  },
};
