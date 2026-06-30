import {
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  CommandResult,
  DeferredPromptResolveContext,
  SlashCommand,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { SkillActivationSource } from '@/telemetry/enums';
import { trackSkillUsage } from '@/telemetry/trackSkillUsage';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';
import { sanitizeSkillName } from '@/utils/skills/paths';

import type { Skill } from '@industry/common/settings';

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/[\r\n\t]/g, ' ');
}

function buildSkillCommandMessage(skill: Skill, userText: string): string {
  const escapedSkillName = escapeAttributeValue(skill.metadata.name);
  const escapedFilePath = escapeAttributeValue(skill.filePath);
  const escapedUserText = escapeUserMessageSystemTags(userText);
  const location = skill.location === 'project' ? 'project' : 'personal';

  return (
    `${SYSTEM_NOTIFICATION_START}\n` +
    `Skills provide specialized capabilities and domain knowledge. The user has selected the following skill for immediate execution. Begin following the skill's instructions now.\n` +
    `<skill filePath="${escapedFilePath}">\n` +
    `<name>${escapedSkillName}</name>\n` +
    `<description>${skill.metadata.description || 'No description provided'} (${location})</description>\n` +
    `${skill.systemPrompt}\n` +
    `</skill>\n` +
    `${SYSTEM_NOTIFICATION_END}${userText ? `\n\n${escapedUserText}` : ''}`
  );
}

export function buildSlashCommandsForSkills(options: {
  skills: Skill[];
  existingCommandNamesLowercase: Set<string>;
}): { commands: SlashCommand[]; skippedDueToNameConflict: string[] } {
  const commands: SlashCommand[] = [];
  const skippedDueToNameConflict: string[] = [];

  for (const skill of options.skills) {
    const skillNameLower = skill.metadata.name.toLowerCase();

    if (options.existingCommandNamesLowercase.has(skillNameLower)) {
      skippedDueToNameConflict.push(skill.metadata.name);
      continue;
    }

    const resolveSkillPrompt = async (
      args: string[],
      context: DeferredPromptResolveContext,
      rawArgs?: string
    ): Promise<CommandResult> => {
      const userText = (rawArgs ?? args.join(' ')).trim();

      trackSkillUsage({
        skillName: sanitizeSkillName(skill.metadata.name),
        location: skill.location,
        activationSource: SkillActivationSource.SlashCommand,
      });

      const activatedMsg = getI18n().t(
        'commands:slashMessages.skills.activated',
        { name: skill.metadata.name }
      );
      context.addEphemeralSystemMessage(
        userText ? `${activatedMsg}: ${userText}` : activatedMsg,
        {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return {
        handled: true,
        shouldRunAgent: true,
        messageText: buildSkillCommandMessage(skill, userText),
      };
    };

    const cmd: SlashCommand = {
      name: skill.metadata.name,
      description: skill.metadata.description || 'No description provided',
      resolveDeferredPrompt: resolveSkillPrompt,
      execute: resolveSkillPrompt,
    };

    commands.push(cmd);
    options.existingCommandNamesLowercase.add(skillNameLower);
  }

  return { commands, skippedDueToNameConflict };
}
