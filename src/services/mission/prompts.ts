/**
 * Mission Decomposition Prompts
 *
 * Bootstrap prompts for orchestrator and worker sessions in mission decomposition.
 * These are minimal prompts that kick off the built-in skills.
 */

import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { Feature } from '@/services/mission/types';
import {
  MISSION_ORCHESTRATOR_SYSTEM_PROMPT,
  SKILL_NAME_MISSION_WORKER_BASE,
  VALIDATION_SKILL_NAMES,
} from '@/skills/builtin/constants';

import type { WorkerHandoff } from '@industry/drool-core/tools/definitions';

/**
 * System prompt for orchestrator sessions.
 * Contains the full orchestrator context directly (not as a skill).
 */
export function getOrchestratorSystemPrompt(): string {
  return MISSION_ORCHESTRATOR_SYSTEM_PROMPT;
}

export function getMissionApprovalReminder(missionDir: string): string {
  return `${SYSTEM_REMINDER_START}
The mission has been approved. You must now author mission artifacts in ${missionDir}:
- ${missionDir}/architecture.md
- ${missionDir}/validation-contract.md (use subagents per area within each surface + cross-area, then synthesize)
- ${missionDir}/validation-state.json (initialize with all assertion IDs as "pending")
- ${missionDir}/features.json (each leaf feature has "fulfills" claiming assertion IDs)
- ${missionDir}/AGENTS.md
- ${missionDir}/skills/
- ${missionDir}/services.yaml
- ${missionDir}/init.sh
- ${missionDir}/library/

After these artifacts are authored, call StartMissionRun to begin execution.
${SYSTEM_REMINDER_END}`;
}

function formatWorkerHandoffSummaries(workerHandoffs: WorkerHandoff[]): string {
  if (workerHandoffs.length === 0) {
    return '';
  }

  const summaries = workerHandoffs
    .map(
      (handoff) => `- Feature ID: ${handoff.featureId}
  Result: ${handoff.resultState}
  Implemented: ${handoff.whatWasImplemented}
  Discovered issues: ${handoff.discoveredIssuesCount}
  Unfinished work items: ${handoff.unfinishedWorkCount}
  Handoff file: ${handoff.handoffFile}`
    )
    .join('\n');

  return `\nCompleted features since the last review:
${summaries}\n`;
}

/**
 * System reminder when mission is paused.
 * Tells the orchestrator how to resume execution and, when relevant,
 * provides context about the interrupted worker and in-progress feature.
 */
export function getMissionPausedReminder(
  interruptedWorkerSessionId?: string | null,
  inProgressFeature?: Pick<
    Feature,
    'id' | 'description' | 'milestone' | 'skillName'
  > | null,
  workerHandoffs: WorkerHandoff[] = []
): string {
  const featureContext = inProgressFeature
    ? `\nIn-progress feature when paused:
- ID: ${inProgressFeature.id}
- Description: ${inProgressFeature.description}
- Milestone: ${inProgressFeature.milestone ?? 'none'}
- Skill: ${inProgressFeature.skillName}\n`
    : '';
  const handoffSummaries = formatWorkerHandoffSummaries(workerHandoffs);
  const pausedContext = interruptedWorkerSessionId
    ? `The mission was paused while worker session "${interruptedWorkerSessionId}" was in progress.`
    : 'The mission was paused between workers.';
  const resumeInstructions = interruptedWorkerSessionId
    ? `Calling start_mission_run will resume the current paused worker from where it left off.

Calling start_mission_run with restartFeature=true will discard the paused worker and restart the in-progress feature from scratch with a new worker.

To run a different feature first, insert it at the top of features.json and call start_mission_run. The runner will revert the in-progress feature to pending, run the inserted feature, then later re-run the preempted feature from scratch with a new worker.`
    : `Calling start_mission_run will continue the mission.`;

  return `${SYSTEM_REMINDER_START}
${pausedContext}
${featureContext}
${handoffSummaries}
${resumeInstructions}
${SYSTEM_REMINDER_END}`;
}
/**
 * Static system prompt addition for worker sessions.
 * Used in systemPromptOverride to set worker context.
 */
function getMissionFilesSection(missionDir?: string): string {
  const missionDirDisplay = missionDir ?? '<missionDir>';

  return `## Mission Files

The following files are in ${missionDirDisplay}:
- mission.md
- architecture.md
- validation-contract.md
- validation-state.json
- features.json (jq '.features[:5] | map({id, description, status, milestone, skillName})' features.json)
- AGENTS.md
- services.yaml
- init.sh
- library/

If skill instructions reference \`{missionDir}\`, substitute it with ${missionDirDisplay}.

If your feature has \`fulfills\` (assertion IDs), read those assertions from \`${missionDirDisplay}/validation-contract.md\`. They specify the exact behavior your implementation must satisfy — use them to guide your work.`;
}

function getAssignedFeatureSection(feature: Feature): string {
  return `## Your Assigned Feature

\`\`\`json
${JSON.stringify(
  {
    id: feature.id,
    description: feature.description,
    skillName: feature.skillName,
    milestone: feature.milestone,
    preconditions: feature.preconditions,
    expectedBehavior: feature.expectedBehavior,
    fulfills: feature.fulfills,
  },
  null,
  2
)}
\`\`\``;
}

export function getWorkerSystemPrompt(
  missionDir?: string,
  feature?: Feature
): string {
  const featureSection = feature
    ? `\n\n${getAssignedFeatureSection(feature)}`
    : '';
  return `You are a worker in a multi-agent mission.

${getMissionFilesSection(missionDir)}${featureSection}

## CRITICAL: Skills

Your initial user message contains the worker skill you must invoke and follow. This skill define your procedures - you cannot complete your work without them.

If a skill you are instructed to invoke does not exist (Skill tool returns an error), you must return to the orchestrator immediately via EndFeatureRun with returnToOrchestrator: true. Do not attempt to proceed without the skill.

If the skill content is no longer visible in your conversation (e.g., after context compaction), you MUST re-invoke the skill(s) before continuing work.

REMEMBER TO CALL ENDFEATURERUN WHEN YOU ARE DONE.`;
}

/**
 * Dynamic bootstrap prompt for worker sessions (sent as user message).
 * Contains mission-specific paths, the assigned feature, and the skill to invoke.
 * Validation workers skip mission-worker-base and invoke their skill directly.
 *
 * Structure:
 * - User-visible: Feature JSON
 * - System-hidden: Technical instructions wrapped in <system-reminder>
 */
export function getWorkerBootstrapPrompt(
  missionDir: string,
  feature: Feature,
  workerSessionId?: string
): string {
  const isValidationWorker = VALIDATION_SKILL_NAMES.includes(feature.skillName);

  // agent-browser uses per-session Unix domain sockets under os.tmpdir(). On macOS,
  // long session names (e.g., full UUIDs + "__u1") can exceed socket path limits.
  // Use a short, deterministic session base derived from the worker session id.
  const compactWorkerSessionId = workerSessionId
    ? workerSessionId.replace(/[^a-zA-Z0-9]/g, '')
    : '';
  const agentBrowserSessionBase = compactWorkerSessionId
    ? compactWorkerSessionId.slice(0, 12)
    : '<workerSessionId>';

  const taskInstructions = isValidationWorker
    ? `## Your Task

1. Invoke the '${feature.skillName}' skill to complete your assigned validation
2. Call EndFeatureRun when done`
    : `## Your Task

1. First, invoke the '${SKILL_NAME_MISSION_WORKER_BASE}' skill for startup procedures
2. Then, invoke the '${feature.skillName}' skill to complete your assigned feature
3. Call EndFeatureRun when done`;

  return `<system-reminder>
You are a worker assigned to execute feature "${feature.id}".

## Worker Session

Your worker session id is: ${workerSessionId ?? '(unknown)'}

If you need browser automation during this mission, use agent-browser.

## agent-browser Rules:
- Never use the "default" session.
- Always pass --session.
  - Single browser: --session "${agentBrowserSessionBase}"
  - Multi-browser (realtime / multi-user): --session "${agentBrowserSessionBase}__u1", "${agentBrowserSessionBase}__u2", etc.
- Before EndFeatureRun (even on errors), close every session you opened:
  - agent-browser --session "<session>" close
Debug: agent-browser session list

**PERFORMANCE TIP:** Parallelize your startup by reading mission context files and invoking your skills in a single tool call batch. These reads are independent and can run simultaneously.

${taskInstructions}

REMEMBER TO CALL ENDFEATURERUN WHEN YOU ARE DONE.
</system-reminder>

## Your Assigned Feature

\`\`\`json
${JSON.stringify(
  {
    id: feature.id,
    description: feature.description,
    skillName: feature.skillName,
    milestone: feature.milestone,
    preconditions: feature.preconditions,
    expectedBehavior: feature.expectedBehavior,
  },
  null,
  2
)}
\`\`\``;
}
