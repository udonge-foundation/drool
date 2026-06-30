import { logWarn } from '@industry/logging';

import type { AvailableCommand } from '@/acp/types';
import { buildSlashCommandsForSkills } from '@/commands/skills/BuildSlashCommandsForSkills';
import type { DeferredPromptResolveContext } from '@/commands/types';
import { getAllSkills } from '@/skills/builtin';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { Skill } from '@industry/common/settings';

function isAcpUserInvocableSkill(skill: Skill): boolean {
  return (
    skill.validationResult.valid &&
    skill.metadata.enabled !== false &&
    skill.metadata.userInvocable !== false
  );
}

function bySkillName(a: Skill, b: Skill): number {
  return a.metadata.name.localeCompare(b.metadata.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeUserTextAfterCommandRemoval(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function joinPromptParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function splitPromptBySkillCommands(
  promptText: string,
  commandNames: string[]
) {
  const commandNamePattern = commandNames
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (!commandNamePattern) {
    return null;
  }

  const commandPattern = new RegExp(
    `(^|\\s)/(${commandNamePattern})(?=$|\\s)`,
    'gi'
  );
  const parts: Array<
    { kind: 'text'; text: string } | { kind: 'command'; commandName: string }
  > = [];
  let cursor = 0;

  for (
    let match = commandPattern.exec(promptText);
    match !== null;
    match = commandPattern.exec(promptText)
  ) {
    const slashIndex = match.index + match[1].length;
    const commandEndIndex = slashIndex + match[2].length + 1;
    const precedingText = normalizeUserTextAfterCommandRemoval(
      promptText.slice(cursor, slashIndex)
    );
    if (precedingText) {
      parts.push({ kind: 'text', text: precedingText });
    }
    parts.push({ kind: 'command', commandName: match[2].toLowerCase() });
    cursor = commandEndIndex;
  }

  if (!parts.some((part) => part.kind === 'command')) {
    return null;
  }

  const trailingText = normalizeUserTextAfterCommandRemoval(
    promptText.slice(cursor)
  );
  if (trailingText) {
    parts.push({ kind: 'text', text: trailingText });
  }

  return parts;
}

async function getAcpUserInvocableSkills(): Promise<Skill[]> {
  const skills = await getAllSkills({ validOnly: true });
  return skills.filter(isAcpUserInvocableSkill).sort(bySkillName);
}

export async function getAcpAvailableCommands(): Promise<AvailableCommand[]> {
  const skills = await getAcpUserInvocableSkills();
  return skills.map((skill) => ({
    name: skill.metadata.name,
    description: skill.metadata.description || 'No description provided',
  }));
}

export async function sendAcpAvailableCommandsUpdate(
  connection: AgentSideConnection,
  sessionId: string
): Promise<void> {
  const availableCommands = await getAcpAvailableCommands();
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands,
    } as unknown as Parameters<
      AgentSideConnection['sessionUpdate']
    >[0]['update'],
  });
}

export async function resolveAcpSkillSlashPrompt(
  promptText: string,
  context: DeferredPromptResolveContext = {
    addEphemeralSystemMessage: () => {},
  }
): Promise<string | null> {
  const skills = await getAcpUserInvocableSkills();
  const { commands } = buildSlashCommandsForSkills({
    skills,
    existingCommandNamesLowercase: new Set(),
  });

  const promptParts = splitPromptBySkillCommands(
    promptText,
    commands.map((cmd) => cmd.name)
  );
  if (!promptParts) {
    return null;
  }
  const commandsByName = new Map(
    commands.map((command) => [command.name.toLowerCase(), command])
  );
  const resolvedParts: string[] = [];

  for (const part of promptParts) {
    if (part.kind === 'text') {
      resolvedParts.push(escapeUserMessageSystemTags(part.text));
      continue;
    }

    const command = commandsByName.get(part.commandName);
    if (!command?.resolveDeferredPrompt) {
      return null;
    }

    const result = await command.resolveDeferredPrompt([], context, '');

    if (!result.handled || !result.messageText) {
      logWarn('[ACP] Failed to resolve skill slash command', {
        command: part.commandName,
      });
      return null;
    }

    resolvedParts.push(result.messageText);
  }

  return joinPromptParts(resolvedParts);
}

export async function resolveAcpSkillSlashPromptForAgent(
  promptText: string
): Promise<string> {
  return (await resolveAcpSkillSlashPrompt(promptText)) ?? promptText;
}
