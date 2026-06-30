import chalk from 'chalk';

import {
  ContextCategoryColorKey,
  type GetContextBreakdownResult,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  DroolLocation,
  SkillLocation,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';

import { formatPercent } from '@/commands/contextUtils';
import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { getThemedColors } from '@/components/chat/themedColors';
import { MC_COLORS } from '@/components/mission-control/constants';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { SYSTEM_PROMPT_TOKENS } from '@/utils/constants';
import { computeContextPercentage } from '@/utils/contextUsage';
import { formatCompactNumber } from '@/utils/tokenFormatting';

const DEFAULT_BAR_WIDTH = 70;

type ChalkFn = (text: string) => string;

type CategoryColors = Record<ContextCategoryColorKey, ChalkFn> & {
  free: ChalkFn;
  label: ChalkFn;
  emphasis: ChalkFn;
  dim: ChalkFn;
};

function getCategoryColors(): CategoryColors {
  const mc = MC_COLORS;
  const colors = getThemedColors();
  return {
    systemPrompt: chalk.hex(mc.active), // active color
    systemTools: chalk.hex(mc.ref), // teal
    mcpTools: chalk.cyan, // blue (MCP tools)
    userInfo: chalk.hex(mc.done), // olive/green
    agentsMd: chalk.hex(colors.warning), // warning color
    customAgents: chalk.hex(mc.worker), // gray
    skills: chalk.hex(mc.fail), // red
    messages: chalk.hex(mc.progress), // green
    free: chalk.hex(mc.barEmpty), // dim gray/con
    label: chalk.hex(mc.secondary), // muted text
    emphasis: chalk.hex(mc.emphasis), // bright text
    dim: chalk.hex(mc.tertiary), // dim text
  };
}

function tokensDetail(tokens: number): string {
  return `${formatCompactNumber(tokens)} tokens`;
}

function formatTreeEntry(name: string, detail: string): string {
  const c = getCategoryColors();
  return `${c.dim('\u2514')} ${c.label(name)}${c.dim(':')} ${c.dim(detail)}`;
}

function buildProgressBar(
  categories: GetContextBreakdownResult['categories'],
  maxTokens: number
): string {
  const barWidth = DEFAULT_BAR_WIDTH;
  const c = getCategoryColors();
  const totalUsed = categories.reduce((sum, cat) => sum + cat.tokens, 0);
  const barScale = Math.max(maxTokens, totalUsed);
  const segments: string[] = [];
  let filled = 0;

  for (const cat of categories) {
    if (cat.tokens <= 0) continue;
    const chars = Math.max(1, Math.round((cat.tokens / barScale) * barWidth));
    const clamped = Math.min(chars, barWidth - filled);
    if (clamped > 0) {
      segments.push(c[cat.colorKey]('\u2588'.repeat(clamped)));
      filled += clamped;
    }
  }

  if (filled < barWidth) {
    segments.push(c.free('\u2591'.repeat(barWidth - filled)));
  }

  return segments.join('');
}

// eslint-disable-next-line industry/constants-file-organization
export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show compaction usage and estimated context breakdown',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    try {
      const sessionId = getSessionService().getCurrentSessionId();
      if (!sessionId) {
        context.addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.noActiveSession'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true, shouldRunAgent: false };
      }

      const breakdown =
        await getTuiDaemonAdapter().getContextBreakdown(sessionId);
      const c = getCategoryColors();

      const estimatedUsedFmt = formatCompactNumber(breakdown.usedTokens);
      const budgetFmt = formatCompactNumber(breakdown.contextBudget);
      const estimatedPct = formatPercent(
        breakdown.usedTokens,
        breakdown.contextBudget
      );
      const compactionUsage =
        breakdown.lastCallCompactionTokens === undefined
          ? null
          : computeContextPercentage({
              lastTokenUsage: breakdown.lastCallCompactionTokens,
              tokenLimit: breakdown.contextBudget,
              systemPromptTokens: SYSTEM_PROMPT_TOKENS,
            });

      const lines: string[] = [];
      lines.push(c.emphasis('Context Usage'));
      if (compactionUsage) {
        const adjustedUsedFmt = formatCompactNumber(
          compactionUsage.adjustedUsage
        );
        const adjustedLimitFmt = formatCompactNumber(
          compactionUsage.adjustedLimit
        );
        lines.push(
          `${c.emphasis(breakdown.modelDisplayName)} ${c.dim('\u00B7')} ${c.label(`Compaction meter ${adjustedUsedFmt}/${adjustedLimitFmt} tokens`)} ${c.dim(`(${compactionUsage.display})`)}`
        );
      } else {
        lines.push(
          `${c.emphasis(breakdown.modelDisplayName)} ${c.dim('\u00B7')} ${c.label('Compaction meter available after the first model response')}`
        );
      }
      lines.push('');
      lines.push(
        buildProgressBar(breakdown.categories, breakdown.contextBudget)
      );
      lines.push('');
      lines.push(
        c.label(
          `Estimated usage by category \u00B7 ${estimatedUsedFmt}/${budgetFmt} tokens (${estimatedPct})`
        )
      );

      for (const cat of breakdown.categories) {
        if (cat.tokens <= 0) continue;
        const swatch = c[cat.colorKey]('\u2588\u2588');
        const tokensFmt = formatCompactNumber(cat.tokens);
        const pct = formatPercent(cat.tokens, breakdown.contextBudget);
        lines.push(
          `  ${swatch} ${c.label(cat.name)}  ${c.dim(`${tokensFmt} tokens (${pct})`)}`
        );
      }

      {
        const swatch = c.free('\u2591\u2591');
        const tokensFmt = formatCompactNumber(breakdown.freeTokens);
        const pct = formatPercent(
          breakdown.freeTokens,
          breakdown.contextBudget
        );
        lines.push(
          `  ${swatch} ${c.label('Estimated Free Space')}  ${c.dim(`${tokensFmt} tokens (${pct})`)}`
        );
      }

      lines.push('');
      lines.push(
        c.dim(
          'Note: The compaction meter uses provider-reported usage; category totals are estimates.'
        )
      );

      if (breakdown.skills.length > 0) {
        lines.push('');
        lines.push(`${c.skills('Skills')} ${c.dim('\u00B7 /skills')}`);

        const userSkills = breakdown.skills.filter(
          (s) => s.location === SkillLocation.Personal
        );
        const projectSkills = breakdown.skills.filter(
          (s) => s.location === SkillLocation.Project
        );

        if (userSkills.length > 0) {
          lines.push('');
          lines.push(c.dim('User'));
          for (const s of userSkills) {
            lines.push(formatTreeEntry(s.name, tokensDetail(s.tokens)));
          }
        }
        if (projectSkills.length > 0) {
          lines.push('');
          lines.push(c.dim('Project'));
          for (const s of projectSkills) {
            lines.push(formatTreeEntry(s.name, tokensDetail(s.tokens)));
          }
        }
      }

      if (breakdown.mcpServers.length > 0) {
        lines.push('');
        lines.push(`${c.mcpTools('MCP servers')} ${c.dim('\u00B7 /mcp')}`);
        for (const server of breakdown.mcpServers) {
          lines.push(
            formatTreeEntry(
              server.name,
              `${server.toolCount} tools, ${tokensDetail(server.tokens)}`
            )
          );
        }
      }

      if (breakdown.drools.length > 0) {
        lines.push('');
        lines.push(
          `${c.customAgents('Custom agents')} ${c.dim('\u00B7 /agents')}`
        );

        const userDrools = breakdown.drools.filter(
          (d) => d.location === DroolLocation.Personal
        );
        const projectDrools = breakdown.drools.filter(
          (d) => d.location === DroolLocation.Project
        );

        if (userDrools.length > 0) {
          lines.push('');
          lines.push(c.dim('User'));
          for (const d of userDrools) {
            lines.push(formatTreeEntry(d.name, tokensDetail(d.tokens)));
          }
        }
        if (projectDrools.length > 0) {
          lines.push('');
          lines.push(c.dim('Project'));
          for (const d of projectDrools) {
            lines.push(formatTreeEntry(d.name, tokensDetail(d.tokens)));
          }
        }
      }

      context.addEphemeralSystemMessage(lines.join('\n'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error executing context command');
      return { handled: true, shouldRunAgent: false };
    }
  },
};
