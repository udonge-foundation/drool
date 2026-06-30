import fs from 'fs/promises';
import path from 'path';

import picomatch from 'picomatch';

import { riskLevelToNumber as impactLevelToNumber } from '@industry/drool-core/messages/utils';
import { parseRiskLevel } from '@industry/drool-core/tools/utils';
import {
  extractFilePathFromPatch,
  getFileOperationFromPatch,
  processApplyPatchOperation,
} from '@industry/drool-core/tools/utils/apply-patch';
import { FileOperation } from '@industry/drool-core/tools/utils/enums';
import { computeEditPreview } from '@industry/drool-core/tools/utils/file-tools-utils';
import { FileEditChange } from '@industry/drool-core/tools/utils/types';
import {
  ToolConfirmationType,
  type ToolConfirmationDetails,
} from '@industry/drool-sdk-ext/protocol/drool';
import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';
import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';
import { logInfo, logWarn } from '@industry/logging';
import { autonomyLevelToNumber } from '@industry/utils';
import { stripShellWrapper } from '@industry/utils/shell';

import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getMcpService } from '@/services/mcp/McpService';
import { sessionConfigService } from '@/services/SessionConfigService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { hasUnresolvedSpecOptions } from '@/utils/specPlanValidation';

import type { McpServerConfig } from '@industry/common/settings';

type ParsedMcpToolName = {
  serverName: string;
  actualToolName: string;
};

type McpServerKind = 'browserAutomation';

const MCP_SERVER_KIND_STDIO_IDENTIFIERS: Readonly<
  Record<McpServerKind, ReadonlySet<string>>
> = {
  browserAutomation: new Set([
    '@playwright/mcp',
    'playwright-mcp',
    'chrome-devtools-mcp',
  ]),
};

const MCP_SERVER_KIND_HTTP_SERVER_NAMES: Readonly<
  Record<McpServerKind, ReadonlySet<string>>
> = {
  browserAutomation: new Set([
    'playwright',
    'chrome-devtools',
    'chrome_devtools',
  ]),
};

const MCP_SERVER_KIND_HTTP_HOSTS: Readonly<
  Record<McpServerKind, ReadonlySet<string>>
> = {
  browserAutomation: new Set(['mcp.playwright.dev']),
};

const MCP_SERVER_KIND_IMPACT_OVERRIDES: Readonly<
  Record<McpServerKind, Readonly<Record<string, RiskLevel>>>
> = {
  browserAutomation: {
    browser_navigate: RiskLevel.MEDIUM,
    browser_navigate_back: RiskLevel.LOW,
    browser_snapshot: RiskLevel.LOW,
    browser_tabs: RiskLevel.LOW,
    browser_take_screenshot: RiskLevel.LOW,
  },
};

function resolveMcpAutonomyOverride(
  serverName: string,
  toolName: string
): RiskLevel | undefined {
  const overrides = getSettingsService().getMcpAutonomyOverrides();
  if (!overrides) return undefined;

  const serverOverride = overrides[serverName];
  if (!serverOverride) return undefined;

  const toolLevel = serverOverride.tools?.[toolName];
  if (toolLevel) return parseRiskLevel(toolLevel);

  if (serverOverride.defaultLevel) {
    return parseRiskLevel(serverOverride.defaultLevel);
  }

  return undefined;
}

function parseMcpToolNameFromRawId(toolName: string): ParsedMcpToolName | null {
  if (!toolName.includes('___')) {
    return null;
  }

  const [serverName, ...toolNameParts] = toolName.split('___');
  const actualToolName = toolNameParts.join('___');

  if (!serverName || !actualToolName) {
    return null;
  }

  return {
    serverName,
    actualToolName,
  };
}

async function resolveMcpToolName(
  toolName: string
): Promise<ParsedMcpToolName | null> {
  try {
    const mcpService = getMcpService();
    if (!mcpService.isInitialized()) {
      return parseMcpToolNameFromRawId(toolName);
    }

    const resolvedTool = await mcpService.resolveFormattedToolName(toolName);
    if (resolvedTool) {
      return {
        serverName: resolvedTool.serverName,
        actualToolName: resolvedTool.toolName,
      };
    }
  } catch (error) {
    logWarn('Failed to resolve MCP tool name', {
      toolName,
      error,
    });
  }

  return parseMcpToolNameFromRawId(toolName);
}

function stripPackageVersion(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized.startsWith('@')) {
    const versionIndex = normalized.indexOf('@');
    return versionIndex === -1 ? normalized : normalized.slice(0, versionIndex);
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) {
    return normalized;
  }

  const versionIndex = normalized.indexOf('@', slashIndex + 1);
  return versionIndex === -1 ? normalized : normalized.slice(0, versionIndex);
}

function getNormalizedCommandIdentifiers(command: string): string[] {
  const normalizedPath = command.trim().toLowerCase().replaceAll('\\', '/');
  const identifiers = new Set<string>([
    stripPackageVersion(normalizedPath),
    stripPackageVersion(path.posix.basename(normalizedPath)),
  ]);

  return Array.from(identifiers).filter(Boolean);
}

function getMcpServerKind(
  serverName: string,
  config?: McpServerConfig
): McpServerKind | null {
  if (!config) {
    return null;
  }

  let matchingKind: McpServerKind | undefined;

  if (config.type === 'stdio') {
    const identifiers = new Set<string>([
      ...getNormalizedCommandIdentifiers(config.command),
      ...(config.args ?? []).map(stripPackageVersion),
    ]);

    matchingKind = (
      Object.entries(MCP_SERVER_KIND_STDIO_IDENTIFIERS) as Array<
        [McpServerKind, ReadonlySet<string>]
      >
    ).find(([, knownIdentifiers]) =>
      Array.from(identifiers).some((identifier) =>
        knownIdentifiers.has(identifier)
      )
    )?.[0];
  }

  if (matchingKind) {
    return matchingKind;
  }

  if (config.type !== 'http') {
    return null;
  }

  // HTTP browser automation servers are only recognized via explicit server names
  // or known hosts. Self-hosted localhost endpoints with custom aliases are left to
  // readOnlyHint until we have stronger server identity metadata.
  let hostname: string | undefined;
  try {
    hostname = new URL(config.url).hostname.toLowerCase();
  } catch {
    hostname = undefined;
  }

  return (
    (
      Object.entries(MCP_SERVER_KIND_HTTP_SERVER_NAMES) as Array<
        [McpServerKind, ReadonlySet<string>]
      >
    ).find(([kind, knownNames]) => {
      if (knownNames.has(serverName.toLowerCase())) {
        return true;
      }

      if (!hostname) {
        return false;
      }

      return MCP_SERVER_KIND_HTTP_HOSTS[kind].has(hostname);
    })?.[0] ?? null
  );
}

function getCuratedMcpToolImpactOverride(
  parsedToolName: ParsedMcpToolName,
  config?: McpServerConfig
): RiskLevel | undefined {
  const serverKind = getMcpServerKind(parsedToolName.serverName, config);

  if (!serverKind) {
    return undefined;
  }

  return MCP_SERVER_KIND_IMPACT_OVERRIDES[serverKind][
    parsedToolName.actualToolName
  ];
}

function resolveMcpUrlAutonomyOverride(
  config: McpServerConfig | undefined
): RiskLevel | undefined {
  if (!config || (config.type !== 'http' && config.type !== 'sse')) {
    return undefined;
  }

  const override = getSettingsService()
    .getMcpAutonomyUrlOverrides()
    ?.find(({ urlPattern }) => {
      try {
        return picomatch.isMatch(config.url, urlPattern);
      } catch {
        logWarn('Failed to match MCP autonomy URL override pattern');
        return false;
      }
    });

  return override ? parseRiskLevel(override.defaultLevel) : undefined;
}

async function resolveMcpToolImpactLevel(
  parsedToolName: ParsedMcpToolName
): Promise<RiskLevel> {
  try {
    const mcpService = getMcpService();
    if (!mcpService.isInitialized()) {
      return RiskLevel.HIGH;
    }

    const config = mcpService.getUserMcpConfigs()[parsedToolName.serverName];
    const urlOverride = resolveMcpUrlAutonomyOverride(config);
    const curatedOverride = getCuratedMcpToolImpactOverride(
      parsedToolName,
      config
    );

    if (urlOverride === RiskLevel.HIGH) {
      return urlOverride;
    }

    if (!urlOverride && curatedOverride) {
      return curatedOverride;
    }

    const allTools = await mcpService.getAllTools();
    const serverTools = allTools[parsedToolName.serverName] || [];
    const tool = serverTools.find(
      (candidate) => candidate.name === parsedToolName.actualToolName
    );

    if (urlOverride) {
      if (
        !tool ||
        tool.annotations?.readOnlyHint === false ||
        tool.annotations?.destructiveHint === true
      ) {
        return RiskLevel.HIGH;
      }

      return urlOverride;
    }

    if (tool?.annotations?.readOnlyHint === true) {
      return RiskLevel.LOW;
    }
  } catch (error) {
    logWarn('Failed to resolve MCP tool impact level', {
      toolName: `${parsedToolName.serverName}___${parsedToolName.actualToolName}`,
      error,
    });
  }

  return RiskLevel.HIGH;
}

/**
 * Build a confirmation for a mutating cloud-automation tool. These tools have no
 * dedicated confirmation renderer, so they reuse the Execute confirmation with a
 * human-readable summary. The action is auto-accepted when its impact is within
 * the user's current autonomy threshold, matching the Execute gating.
 */
function buildAutomationMutationConfirmation(params: {
  summary: string;
  impactLevel: RiskLevel;
  riskLevelReason: string;
}): ToolConfirmationDetails | false {
  try {
    const sessionSvc = getSessionService();
    const userThreshold = sessionSvc.isMissionMode()
      ? AutonomyLevel.High
      : sessionSvc.getAutonomyLevel();
    const impactNumber = impactLevelToNumber(params.impactLevel);
    const thresholdNumber = autonomyLevelToNumber(userThreshold);
    if (impactNumber <= thresholdNumber) {
      return false;
    }
  } catch (error) {
    logInfo('Automation confirmation autonomy check error', { error });
  }

  return {
    type: ToolConfirmationType.Execute,
    fullCommand: params.summary,
    command: params.summary,
    extractedCommands: [],
    impactLevel: params.impactLevel,
    riskLevelReason: params.riskLevelReason,
    onConfirm: async () => {},
  };
}

/**
 * Check if a tool execution should require user confirmation
 */
export async function shouldConfirmExecution(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<ToolConfirmationDetails | false> {
  // Global bypass for exec-mode unsafe flag
  if (getExecRuntimeConfig().getSkipAllConfirmations()) {
    return false;
  }

  switch (toolName) {
    case 'Read':
    case 'LS':
      // Reading operations don't need confirmation
      return false;

    case 'Create': {
      const filePath =
        typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

      // Check if we're in any auto mode or Mission mode - auto-accept file edits
      if (getSessionService().shouldAutoApproveFileEdits()) {
        return false;
      }

      // For create operations, we know the old content is empty and new content is provided
      const newContent =
        typeof toolInput.content === 'string' ? toolInput.content : '';
      const fileName = filePath.split('/').pop() || 'file';

      logInfo('Returning create confirmation details', {
        filePath,
      });

      return {
        type: ToolConfirmationType.Create,
        filePath,
        fileName,
        content: newContent,
        onConfirm: async () => {}, // Will be set by the hook
      };
    }

    case 'Edit': {
      const filePath = toolInput.file_path as string;

      // Check if we're in any auto mode or Mission mode - auto-accept file edits
      if (getSessionService().shouldAutoApproveFileEdits()) {
        return false;
      }

      // Try to compute the new content for diff display
      let oldContent: string | undefined;
      let result: { success: boolean; newContent?: string } | undefined;

      try {
        oldContent = await fs.readFile(filePath, 'utf-8');

        // Prepare changes array
        const changes: FileEditChange[] =
          toolName === 'Edit'
            ? [
                {
                  old_str: toolInput.old_str as string,
                  new_str: toolInput.new_str as string,
                  change_all: toolInput.change_all as boolean | undefined,
                },
              ]
            : (
                toolInput.changes as Array<{
                  old_str: string;
                  new_str: string;
                  change_all?: boolean;
                }>
              ).map((change) => ({
                old_str: change.old_str,
                new_str: change.new_str,
                change_all: change.change_all,
              }));

        // Use the shared helper to compute preview with validation
        if (oldContent !== undefined) {
          result = computeEditPreview(oldContent, changes);

          // If validation failed, still show confirmation (without diff preview)
          if (!result.success) {
            logWarn('Edit validation failed during confirmation phase', {
              filePath,
            });
          }
        }
      } catch (error) {
        logWarn('Error reading file for confirmation', { error, filePath });
        // File may not exist yet — still require confirmation at lower autonomy levels
      }

      logInfo('Returning edit confirmation details', {
        filePath,
      });

      return {
        type: ToolConfirmationType.Edit,
        filePath,
        fileName: path.basename(filePath),
        oldContent,
        newContent: result?.newContent,
        onConfirm: async () => {}, // Will be set by the hook
      };
    }

    case 'Execute': {
      const command = toolInput.command as string;
      const strippedCommand = stripShellWrapper(command);

      // Blocked (hard-denylisted) commands can never run and can never be
      // approved. Skip the confirmation prompt entirely (before any further
      // setup); the execution layer hard-blocks the command and returns an
      // error to the agent.
      if (sessionConfigService.isCommandBlocked(command)) {
        return false;
      }

      const toolProvidedRiskReason =
        typeof toolInput.riskLevelReason === 'string' &&
        toolInput.riskLevelReason.trim().length > 0
          ? toolInput.riskLevelReason.trim()
          : undefined;

      const extractedCommands =
        sessionConfigService.getExtractedCommands(strippedCommand);

      // Check if command is in the denylist (including checking substitutions)
      const deniedPattern =
        sessionConfigService.getDeniedCommandPattern(strippedCommand);
      const isDenied = deniedPattern !== null;

      // Check allowlist after security checks - if explicitly allowed and safe (not denied), skip other checks
      if (!isDenied && sessionConfigService.isCommandAllowed(strippedCommand)) {
        return false;
      }

      if (isDenied) {
        return {
          type: ToolConfirmationType.Execute,
          fullCommand: strippedCommand,
          command: extractedCommands.join(', '),
          extractedCommands,
          impactLevel: RiskLevel.HIGH, // Denylisted commands are always high impact
          riskLevelReason: deniedPattern
            ? `Matched deny-list entry "${deniedPattern}". Deny-listed commands always require manual approval.`
            : 'Matched the command deny list. Deny-listed commands always require manual approval.',
          onConfirm: async () => {},
        };
      }

      // Impact-based confirmation: compare tool-provided impact vs global threshold
      // Parse riskLevel - defaults to HIGH for invalid/missing values
      const effectiveImpact = parseRiskLevel(toolInput.riskLevel);

      try {
        // Mission mode uses High autonomy level for command permissions
        const sessionSvc = getSessionService();
        const userThreshold = sessionSvc.isMissionMode()
          ? AutonomyLevel.High
          : sessionSvc.getAutonomyLevel();

        const impactNumber = impactLevelToNumber(effectiveImpact);
        const thresholdNumber = autonomyLevelToNumber(userThreshold);
        // Command should auto-accept when impact is LESS THAN OR EQUAL to threshold
        // Impact levels: none=0, low=1, medium=2, high=3
        // Autonomy levels: Off=0, Low=1, Medium=2, High=3
        // If impact <= threshold, we auto-accept
        const shouldAutoAccept = impactNumber <= thresholdNumber;

        if (shouldAutoAccept) {
          // Impact is within acceptable threshold → auto-run, no confirmation
          return false;
        }
      } catch (error) {
        // On any error, fall through to confirmation
        logInfo('Impact parsing error', { error, command: strippedCommand });
      }

      return {
        type: ToolConfirmationType.Execute,
        fullCommand: strippedCommand,
        command: extractedCommands.join(', '),
        extractedCommands,
        impactLevel: effectiveImpact,
        riskLevelReason: toolProvidedRiskReason,
        onConfirm: async () => {},
      };
    }

    case 'ExitSpecMode': {
      // Auto-approve in exec/task modes to enable non-interactive flow
      if (getDroolRuntimeService().isNonInteractiveCLIMode()) {
        return false; // No confirmation needed
      }

      // Interactive mode - require confirmation
      const plan =
        typeof toolInput.plan === 'string'
          ? toolInput.plan
          : String(toolInput.plan);
      const title =
        typeof toolInput.title === 'string' ? toolInput.title : undefined;

      if (hasUnresolvedSpecOptions(plan)) {
        logInfo('Skipping spec confirmation for unresolved option plan', {
          sessionId: getSessionService().getCurrentSessionId() ?? undefined,
          hasInput: Boolean(title),
          length: title?.length ?? 0,
        });
        return false;
      }

      logInfo('Returning spec mode confirmation', {
        sessionId: getSessionService().getCurrentSessionId() ?? undefined,
        hasInput: Boolean(title),
        length: title?.length ?? 0,
      });

      return {
        type: ToolConfirmationType.ExitSpecMode,
        plan,
        title,
        onConfirm: async () => {}, // Will be set by the hook
      };
    }

    case 'ProposeMission': {
      // Auto-approve in exec/task modes to enable non-interactive flow
      if (getDroolRuntimeService().isNonInteractiveCLIMode()) {
        return false;
      }

      // Interactive mode - require confirmation for mission proposals
      const proposal =
        typeof toolInput.proposal === 'string'
          ? toolInput.proposal
          : String(toolInput.proposal || '');
      const title =
        typeof toolInput.title === 'string' ? toolInput.title : undefined;

      logInfo('Returning mission proposal confirmation', {
        sessionId: getSessionService().getCurrentSessionId() ?? undefined,
        hasInput: Boolean(title),
        length: title?.length ?? 0,
      });

      return {
        type: ToolConfirmationType.ProposeMission,
        proposal,
        title,
        onConfirm: async () => {}, // Will be set by the hook
      };
    }

    case 'StartMissionRun':
      return false;

    case 'AskUser':
      // AskUser executes directly - the executor waits for user input via requestAskUserAnswers
      return false;

    case 'ApplyPatch': {
      const patchInput = toolInput.input as string;

      // Check if we're in any auto mode or Mission mode - auto-accept file edits
      if (getSessionService().shouldAutoApproveFileEdits()) {
        return false;
      }

      // Extract file path from the patch
      const extractedFilePath = extractFilePathFromPatch(patchInput);
      if (!extractedFilePath) {
        // If we can't extract the file path, still require confirmation
        return {
          type: ToolConfirmationType.ApplyPatch,
          filePath: 'unknown',
          fileName: 'unknown',
          patchContent: patchInput,
          onConfirm: async () => {},
        };
      }

      let filePath: string;
      let normalizedPath: string;

      if (path.isAbsolute(extractedFilePath)) {
        filePath = extractedFilePath;
        normalizedPath = extractedFilePath;
      } else {
        normalizedPath = extractedFilePath;
        filePath = path.resolve(normalizedPath);
      }

      const fileName = path.basename(filePath);

      // Try to compute the new content for diff display
      let oldContent: string | undefined;
      let newContent: string | undefined;

      try {
        const operationType = getFileOperationFromPatch(patchInput);

        if (operationType === FileOperation.Create) {
          // For create operations, old content is empty
          oldContent = '';

          // Process the patch to get the new content
          const patchResult = processApplyPatchOperation({
            operationType,
            filePath: normalizedPath,
            patchText: patchInput,
            fileContentRecord: {},
          });

          if (patchResult.success) {
            newContent = patchResult.content;
          }
        } else if (operationType === FileOperation.Update) {
          oldContent = await fs.readFile(filePath, 'utf-8');

          // Process the patch to get the new content
          const fileContentRecord: Record<string, string> = {};
          const keyPath = path.isAbsolute(extractedFilePath)
            ? extractedFilePath
            : normalizedPath;
          fileContentRecord[keyPath] = oldContent;

          const patchResult = processApplyPatchOperation({
            operationType,
            filePath: keyPath,
            patchText: patchInput,
            fileContentRecord,
          });

          if (patchResult.success) {
            newContent = patchResult.content;
          }
        }
      } catch (error) {
        logInfo('Error computing diff for ApplyPatch confirmation', { error });
        // If we can't compute the diff, continue without it
      }
      logInfo('Returning ApplyPatch confirmation details', {
        filePath,
      });

      return {
        type: ToolConfirmationType.ApplyPatch,
        filePath,
        fileName,
        patchContent: patchInput,
        oldContent,
        newContent,
        onConfirm: async () => {},
      };
    }

    case 'CreateAutomation': {
      const name =
        typeof toolInput.name === 'string' ? toolInput.name : 'automation';
      return buildAutomationMutationConfirmation({
        summary: `Create cloud automation "${name}" and run it once now`,
        impactLevel: RiskLevel.MEDIUM,
        riskLevelReason:
          'Creates a scheduled cloud automation on a drool computer and triggers an immediate run.',
      });
    }

    case 'EditAutomation': {
      const automationId =
        typeof toolInput.automationId === 'string'
          ? toolInput.automationId
          : 'unknown';
      return buildAutomationMutationConfirmation({
        summary: `Update cloud automation ${automationId}`,
        impactLevel: RiskLevel.MEDIUM,
        riskLevelReason:
          'Modifies an existing scheduled cloud automation (schedule, prompt, status, etc.).',
      });
    }

    case 'DeleteAutomation': {
      const automationId =
        typeof toolInput.automationId === 'string'
          ? toolInput.automationId
          : 'unknown';
      return buildAutomationMutationConfirmation({
        summary: `Delete cloud automation ${automationId}`,
        impactLevel: RiskLevel.HIGH,
        riskLevelReason:
          'Permanently removes a scheduled cloud automation. This cannot be undone from the CLI.',
      });
    }

    default: {
      // Check for MCP tools
      const parsedMcpToolName = await resolveMcpToolName(toolName);
      if (parsedMcpToolName) {
        // Determine impact level: named override > URL rule > curated mapping > annotations
        const autonomyOverride = resolveMcpAutonomyOverride(
          parsedMcpToolName.serverName,
          parsedMcpToolName.actualToolName
        );
        const impactLevel =
          autonomyOverride ??
          (await resolveMcpToolImpactLevel(parsedMcpToolName));

        // 1. Check persistent permissions first (cross-session approval)
        try {
          const { getMcpPermissionService } = await import(
            '@/services/mcp/McpPermissionService'
          );
          const { resolveCurrentMcpServerIdentity } = await import(
            '@/services/mcp/mcpServerIdentity'
          );
          const mcpPermissionService = getMcpPermissionService();
          const currentServerIdentity = await resolveCurrentMcpServerIdentity(
            parsedMcpToolName.serverName
          );

          if (
            mcpPermissionService.isToolPersistentlyApproved(
              parsedMcpToolName.serverName,
              parsedMcpToolName.actualToolName,
              impactLevel,
              currentServerIdentity
            )
          ) {
            logInfo(
              '[shouldConfirmExecution] MCP tool auto-approved via persistent permission',
              {
                // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
                value: {
                  serverName: parsedMcpToolName.serverName,
                  toolName: parsedMcpToolName.actualToolName,
                  impactLevel,
                },
              }
            );
            return false; // Auto-approve based on persistent permission
          }
        } catch (error) {
          logWarn(
            '[shouldConfirmExecution] Error checking MCP persistent permissions',
            {
              error,
              toolName,
            }
          );
          // Fall through to autonomy-based check on error
        }

        // 2. Check autonomy-based approval (session-level)
        try {
          const impactNumber = impactLevelToNumber(impactLevel);
          // Mission mode uses High autonomy level for MCP tool permissions
          const sessionSvc = getSessionService();
          const userThreshold = sessionSvc.isMissionMode()
            ? AutonomyLevel.High
            : sessionSvc.getAutonomyLevel();
          const thresholdNumber = autonomyLevelToNumber(userThreshold);
          // If impact <= threshold, we auto-accept
          if (impactNumber <= thresholdNumber) {
            return false;
          }
        } catch (error) {
          logInfo('MCP tool autonomy check error', { error, toolName });
        }

        // 3. Require confirmation - include server/tool names for "Allow always" option
        return {
          type: ToolConfirmationType.McpTool,
          toolName,
          impactLevel,
          serverName: parsedMcpToolName.serverName,
          actualToolName: parsedMcpToolName.actualToolName,
          onConfirm: async () => {},
        };
      }

      // Unknown tools don't need confirmation by default
      return false;
    }
  }
}
