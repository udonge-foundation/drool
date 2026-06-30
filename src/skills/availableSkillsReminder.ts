import { type Skill } from '@industry/common/settings';
import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

import { getAllSkills } from '@/skills/builtin';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

const STABLE_SKILL_TOOL_DESCRIPTION = `Activate a skill within the main conversation.

Use this tool only with a valid skill name from the latest system reminders. Available skill names are provided in startup and dynamic <system-reminder> blocks.

Proactively invoke a listed skill when the user's request warrants specialized instructions or would benefit from that skill's domain knowledge. Do not invent skill names, and do not invoke a skill that is already activated.`;

export function getStableSkillToolDescription(): string {
  return STABLE_SKILL_TOOL_DESCRIPTION;
}

export function getModelInvocableSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.metadata.disableModelInvocation);
}

export async function getAvailableSkillsForReminder(): Promise<Skill[]> {
  const skills = await getAllSkills({
    validOnly: true,
    excludeDynamic: true,
  });
  return getModelInvocableSkills(skills);
}

function formatSkillMetadataForReminder(value: string): string {
  return escapeUserMessageSystemTags(value).replace(/\s+/g, ' ').trim();
}

export function formatAvailableSkillEntry(skill: Skill): string {
  const name = formatSkillMetadataForReminder(skill.metadata.name);
  const description =
    formatSkillMetadataForReminder(skill.metadata.description ?? '') ||
    'No description provided';
  return `${name}: ${description}`;
}

export function formatAvailableSkillsReminder(skills: Skill[]): string {
  const modelInvocableSkills = getModelInvocableSkills(skills);
  if (modelInvocableSkills.length === 0) {
    return '';
  }

  const skillEntries = modelInvocableSkills
    .map(formatAvailableSkillEntry)
    .join('\n');

  return `${SYSTEM_REMINDER_START}
Available skills for the Skill tool are listed below. The Skill tool definition relies on this system reminder for valid skill names.

Skills instructions:
When users ask you to perform tasks, check if any available skill can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke skills using the Skill tool with the skill name only.
- The skill's prompt will expand and provide detailed instructions on how to complete the task.
- Only use skills listed in the available-skills system reminders or dynamic skill-discovery reminders.
- Do not invoke a skill that is already running.

Available skills:
${skillEntries}

Proactively invoke a listed skill when the user's request warrants specialized instructions or would benefit from that skill's domain knowledge.
${SYSTEM_REMINDER_END}`;
}
