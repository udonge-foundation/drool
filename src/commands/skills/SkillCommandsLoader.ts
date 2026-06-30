/**
 * SkillCommandsLoader - Registers user-invocable skills as slash commands
 *
 * Skills with `user-invocable: true` (or not set, since it defaults to true)
 * are registered as slash commands, allowing users to invoke them via `/skill-name`.
 */
import { logWarn } from '@industry/logging';

import { commandRegistry } from '@/commands/registry';
import { buildSlashCommandsForSkills } from '@/commands/skills/BuildSlashCommandsForSkills';
import { getAllSkills } from '@/skills/builtin';

import type { Skill } from '@industry/common/settings';

class SkillCommandsLoader {
  private registeredCommandNames = new Set<string>();

  /**
   * Get user-invocable skills from builtin + filesystem skills.
   * Filters to skills that are:
   * - Valid (validationResult.valid === true)
   * - Enabled (enabled !== false)
   * - User-invocable (userInvocable !== false)
   */
  public async getUserInvocableSkills(): Promise<Skill[]> {
    const skills = await getAllSkills();

    return skills.filter(
      (skill) =>
        skill.validationResult.valid &&
        skill.metadata.enabled &&
        skill.metadata.userInvocable
    );
  }

  /**
   * Register all user-invocable skills as slash commands.
   * Skills are registered after built-in and custom commands,
   * so name conflicts will be silently ignored (first registration wins).
   */
  public async registerAll(): Promise<void> {
    const skills = await this.getUserInvocableSkills();
    this.unregisterAll();

    const existingCommandNames = new Set(
      commandRegistry.getCommands().map((cmd) => cmd.name.toLowerCase())
    );

    const { commands, skippedDueToNameConflict } = buildSlashCommandsForSkills({
      skills,
      existingCommandNamesLowercase: existingCommandNames,
    });

    for (const cmd of commands) {
      commandRegistry.register(cmd);
      this.registeredCommandNames.add(cmd.name.toLowerCase());
    }

    for (const skillName of skippedDueToNameConflict) {
      logWarn('Skill conflicts with existing command, skipping registration', {
        name: skillName,
      });
    }
  }

  public unregisterAll(): void {
    for (const name of this.registeredCommandNames) {
      commandRegistry.unregister(name);
    }
    this.registeredCommandNames.clear();
  }
}

export const skillCommandsLoader = new SkillCommandsLoader();
