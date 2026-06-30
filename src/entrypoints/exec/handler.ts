import { promises as fs } from 'fs';
import path from 'path';

import chalk from 'chalk';

import { SESSION_TAG_MISSION_ORCHESTRATOR } from '@industry/common/session';
import { DroolMode } from '@industry/common/shared';
import { configureIndustryApi } from '@industry/drool-core/api/config';
import { droolApi } from '@industry/drool-core/api/drool';
import { storeAgentReadinessReportRemoteTool } from '@industry/drool-core/tools/definitions';
import {
  SYSTEM_NOTIFICATION_END,
  SYSTEM_NOTIFICATION_START,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ModelID, ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { Metrics } from '@industry/logging';
import {
  AuthenticationError,
  isFetchError,
  MetaError,
} from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { cleanupWorktree, setupWorktree } from '@industry/utils/git';
import { getModelConfig } from '@industry/utils/llm';

import { getIndustryApiConfig } from '@/api/config';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import {
  INSTALL_WIKI_COMMAND_NAME,
  READINESS_REPORT_COMMAND_NAME,
  WIKI_COMMAND_NAME,
} from '@/commands/constants';
import { resolveDeferredPromptFromRawText } from '@/commands/deferredPromptResolution';
import { OutputFormat } from '@/commands/enums';
import { readinessReportCommand } from '@/commands/readiness-report';
import { markReadinessToolsLoaded } from '@/commands/readinessTools';
import { resolveToolSelection } from '@/commands/resolveToolSelection';
import { ToolSelectionResult, ExecCommandOptions } from '@/commands/types';
import { getSessionController } from '@/controllers/SessionController';
import { assertValidOptions } from '@/entrypoints/exec/assertValidOptions';
import {
  AgentEvent,
  subscribeToMultipleAgentEvents,
} from '@/events/AgentEventBus';
import {
  buildExecFailureSummary,
  buildExecSummaryFromResult,
} from '@/exec/exec-summary';
import { runRenderlessExec } from '@/exec/renderlessExecRunner';
import { buildExecEventsFromAssistantMessage } from '@/exec/streamJsonEventHelpers';
import type {
  ExecEvent,
  ExecRunResult,
  ExecSummary,
  ExecUsage,
} from '@/exec/types';
import {
  EXEC_SYSTEM_PROMPT,
  MISSION_EXEC_SYSTEM_PROMPT,
} from '@/hooks/constants';
import { getI18n } from '@/i18n';
import {
  getAvailableModelsForExec,
  getDefaultModelId,
} from '@/models/availability';
import {
  getModelDefaultReasoningEffort,
  getTuiModelConfig,
} from '@/models/config';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getMcpService } from '@/services/mcp/McpService';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getOrchestratorSystemPrompt } from '@/services/mission/prompts';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  BUILTIN_INSTALL_WIKI_SKILL,
  BUILTIN_WIKI_SKILL,
} from '@/skills/builtin/builtinSkillDefinitions';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { commandWrapper } from '@/utils/command-wrapper';
import { safeStdoutWrite } from '@/utils/safeStdoutWrite';
import { changeSessionWorkingDirectory } from '@/utils/sessionCwd';
import { getForkSessionTitle } from '@/utils/sessionFork';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';
import { getCliRuntimeMetricLabels } from '@/utils/startupLatency';
import { ensureTaskInvocationStoreExists } from '@/utils/taskInvocationStore';
import {
  buildToolCatalogResponse,
  buildToolCatalogEntries,
  getRegisteredTools,
} from '@/utils/toolCatalog';
import { ToolCategory } from '@/utils/toolCatalog/enums';

import type { MissionModelSettings } from '@industry/common/settings';
import type { WorktreeSessionInfo } from '@industry/utils/git';

/**
 * Helper functions to write directly to stdout/stderr, bypassing console patch.
 * In exec mode, console.log/error/warn are patched to write to ~/.industry/logs/console.log,
 * so we must use process.stdout/stderr.write directly for user-facing output.
 */
function writeStdout(message: string): void {
  safeStdoutWrite(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

const DEFAULT_EXEC_TAG_NAME = 'exec';

function isStdinPiped(): boolean {
  // Check if stdin is not a TTY (meaning it's piped or redirected)
  return !process.stdin.isTTY;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}

async function readFilePrompt(filePath: string): Promise<string> {
  try {
    const resolvedPath = path.resolve(filePath);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    if (!content.trim()) {
      throw new MetaError('File is empty:', { filePath });
    }
    return content;
  } catch (error) {
    if (error instanceof MetaError) throw error;
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      throw new MetaError('File not found:', { filePath });
    }
    if (errorCode === 'EACCES') {
      throw new MetaError('Permission denied reading file:', { filePath });
    }
    throw new MetaError('Error reading file', {
      filePath,
      cause: error,
    });
  }
}

/**
 * Get token usage from the current session and convert to ExecUsage format.
 * Uses snake_case naming for compatibility with Claude Code and OpenAI Codex CLI conventions.
 */
function getExecUsage(): ExecUsage {
  const tokenUsage = getSessionService().getTokenUsage();
  return {
    input_tokens: tokenUsage.inputTokens,
    output_tokens: tokenUsage.outputTokens,
    cache_read_input_tokens: tokenUsage.cacheReadTokens,
    cache_creation_input_tokens: tokenUsage.cacheCreationTokens,
    ...(tokenUsage.thinkingTokens
      ? { thinking_tokens: tokenUsage.thinkingTokens }
      : {}),
  };
}

/**
 * Get zero usage for error cases where no tokens were consumed.
 */
function getZeroUsage(): ExecUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function printSuccessOutput(
  result: ExecRunResult,
  durationMs: number,
  outputFormat?: OutputFormat
): void {
  const usage = getExecUsage();

  if (outputFormat === OutputFormat.Json) {
    const output: ExecSummary = buildExecSummaryFromResult(
      result,
      durationMs,
      usage
    );
    writeStdout(JSON.stringify(output));
    return;
  }
  if (
    outputFormat === OutputFormat.StreamJson ||
    outputFormat === OutputFormat.Debug
  ) {
    // Emit a final completion event with the result
    const completionEvent: ExecEvent = {
      type: 'completion',
      finalText: result.finalText,
      numTurns: result.numTurns,
      durationMs,
      session_id: result.sessionId,
      timestamp: Date.now(),
      usage,
    };
    safeStdoutWrite(`${JSON.stringify(completionEvent)}\n`);
    return;
  }
  writeStdout(result.finalText);
}

function getUserFacingError(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return getAuthErrorMessage();
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/not authenticated/i.test(msg) || /INDUSTRY_API_KEY/i.test(msg)) {
    return getAuthErrorMessage();
  }
  return msg;
}

async function resolvePromptArg(
  promptArg: string | undefined,
  options: ExecCommandOptions
): Promise<string> {
  const t = getI18n().t;
  // Streaming mode doesn't use prompt argument
  if (
    options.inputFormat === 'stream-json' ||
    options.inputFormat === 'stream-jsonrpc'
  ) {
    if (promptArg) {
      throw new MetaError(t('commands:exec.cannotUsePromptInStreaming'));
    }
    // Return empty string - not used in streaming mode
    return '';
  }

  // Validate mutual exclusivity: can't have both file input and prompt argument
  if (options.file && promptArg) {
    const errorMsg = t('commands:exec.cannotSpecifyBothFileAndPrompt');
    writeStderr(chalk.red(errorMsg));
    throw new MetaError(errorMsg);
  }

  // Priority order: --file flag > piped stdin > direct argument

  // 1. File input via -f/--file flag (highest priority)
  if (options.file) {
    return readFilePrompt(options.file);
  }

  // 2. Automatic stdin detection (piped or redirected)
  if (!promptArg && isStdinPiped()) {
    try {
      const stdinPrompt = await readStdin();
      if (!stdinPrompt.trim()) {
        throw new MetaError('Empty input from stdin');
      }
      return stdinPrompt;
    } catch (error) {
      throw new MetaError('Error reading stdin', {
        errorMessage: getUserFacingError(error),
      });
    }
  }

  // 3. Direct prompt argument
  if (promptArg) {
    // Reject the old '-' syntax with helpful migration message
    if (promptArg === '-') {
      const migrationMessage = t('commands:exec.dashSyntaxDeprecated');
      writeStderr(chalk.red(migrationMessage));
      throw new MetaError(migrationMessage);
    }
    return promptArg;
  }

  // No input provided
  const errorMsg = t('commands:exec.noPromptProvided');

  writeStderr(chalk.red(errorMsg));
  throw new MetaError(errorMsg);
}

async function withWorkingDirectory<T>(
  cwd: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const originalCwd = process.cwd();

  if (!cwd) return fn();

  try {
    process.chdir(path.resolve(cwd));
  } catch (error) {
    writeStderr(
      chalk.red(
        getI18n().t('commands:exec.errorChangingDirectory', { path: cwd })
      )
    );
    writeStderr(chalk.red(getUserFacingError(error)));
    throw error instanceof Error ? error : new MetaError(String(error));
  }

  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * Resolve the AutonomyMode for an exec run. This controls the Execute tool's
 * command risk auto-approval level, NOT which tools are available (that's
 * handled by resolveToolSelection based on the presence of --auto).
 *
 * - Mission mode always uses AutoHigh (full autonomy).
 * - --auto <level> maps to the corresponding AutonomyMode.
 * - No --auto defaults to AutoLow (auto-approve only low-risk shell commands).
 */
function getExecAutonomyMode(
  options: ExecCommandOptions
): AutonomyMode | undefined {
  if (options.mission) return AutonomyMode.AutoHigh;
  // When --auto is provided, autoLevel is passed separately and takes precedence
  // in renderlessExecRunner, so we return undefined to avoid conflicting values.
  if (options.auto) return undefined;
  // No --auto: tools are restricted to read-only set by resolveToolSelection;
  // AutoLow here only governs the Execute tool's risk auto-approval.
  return AutonomyMode.AutoLow;
}

function describeAutonomy(options: ExecCommandOptions): string {
  const t = getI18n().t;
  if (options.skipPermissionsUnsafe) {
    return t('commands:exec.skipPermissionsUnsafe');
  }
  if (options.auto) {
    return t('commands:exec.autoLevel', { level: options.auto });
  }
  return t('commands:exec.readOnly');
}

function getCategoryLabel(category: ToolCategory): string {
  const t = getI18n().t;
  switch (category) {
    case ToolCategory.Read:
      return t('commands:exec.categoryRead');
    case ToolCategory.Edit:
      return t('commands:exec.categoryEdit');
    case ToolCategory.Execute:
      return t('commands:exec.categoryExecute');
    default:
      return t('commands:exec.categoryOther');
  }
}

function printToolCatalog(params: {
  selection: ToolSelectionResult;
  options: ExecCommandOptions;
  outputFormat?: OutputFormat;
}): void {
  const { selection, options, outputFormat } = params;
  const modelConfig = getTuiModelConfig(selection.model);
  const modelDisplay = modelConfig?.displayName ?? selection.model;

  if (outputFormat === OutputFormat.Json) {
    writeStdout(JSON.stringify(buildToolCatalogResponse(selection)));
    return;
  }

  const toolDetails = buildToolCatalogEntries(selection);

  // Separate MCP tools from non-MCP tools for dedicated section
  const mcpTools = toolDetails.filter((e) => e.tool.isMcpTool === true);
  const nonMcpTools = toolDetails.filter((e) => e.tool.isMcpTool !== true);

  const grouped = new Map<ToolCategory, Array<(typeof toolDetails)[number]>>();
  for (const entry of nonMcpTools) {
    const current = grouped.get(entry.category) ?? [];
    current.push(entry);
    grouped.set(entry.category, current);
  }

  const autonomy = describeAutonomy(options);
  const t = getI18n().t;
  writeStdout(
    chalk.bold(t('commands:exec.availableToolsFor', { model: modelDisplay }))
  );
  writeStdout(t('commands:exec.autonomyLabel', { autonomy }));
  writeStdout('');

  const categoryOrder: ToolCategory[] = [
    ToolCategory.Read,
    ToolCategory.Edit,
    ToolCategory.Execute,
    ToolCategory.Other,
  ];
  for (const category of categoryOrder) {
    const tools = grouped.get(category);
    if (!tools || tools.length === 0) continue;
    writeStdout(chalk.cyan(getCategoryLabel(category)));
    for (const entry of tools) {
      const baseAllowed = selection.baseAllowed.has(entry.tool.id);
      const currentlyAllowed = selection.allowed.has(entry.tool.id);
      const override = baseAllowed !== currentlyAllowed;
      const currentLabel = currentlyAllowed
        ? chalk.green('allowed')
        : chalk.gray('blocked');
      const nameSuffix =
        entry.displayName && entry.displayName !== entry.llmId
          ? ` (${entry.displayName})`
          : '';

      const overrideLabel = override ? chalk.blue(' override') : '';
      writeStdout(
        `  • ${entry.llmId}${nameSuffix} - status: ${currentLabel}${overrideLabel}`
      );
    }
    writeStdout('');
  }

  // Print MCP section last, if any
  if (mcpTools.length > 0) {
    writeStdout(chalk.cyan('MCP'));
    for (const entry of mcpTools) {
      const baseAllowed = selection.baseAllowed.has(entry.tool.id);
      const currentlyAllowed = selection.allowed.has(entry.tool.id);
      const override = baseAllowed !== currentlyAllowed;
      const currentLabel = currentlyAllowed
        ? chalk.green('allowed')
        : chalk.gray('blocked');
      const nameSuffix =
        entry.displayName && entry.displayName !== entry.llmId
          ? ` (${entry.displayName})`
          : '';
      const overrideLabel = override ? chalk.blue(' override') : '';
      writeStdout(
        `  • ${entry.llmId}${nameSuffix} - status: ${currentLabel}${overrideLabel}`
      );
    }
    writeStdout('');
  }
}

function printErrorOutput(
  outputFormat: ExecCommandOptions['outputFormat'],
  sessionId: string,
  startTime: number,
  error: unknown
): void {
  // Try to get actual usage if any tokens were consumed, otherwise use zero
  const usage = sessionId ? getExecUsage() : getZeroUsage();

  if (outputFormat === OutputFormat.Json) {
    const durationMs = Date.now() - startTime;
    const message = getUserFacingError(error);
    const errorSummary: ExecSummary = buildExecFailureSummary(
      sessionId,
      durationMs,
      usage,
      0,
      message
    );
    writeStdout(JSON.stringify(errorSummary));
    return;
  }
  if (
    outputFormat === OutputFormat.StreamJson ||
    outputFormat === OutputFormat.Debug
  ) {
    const event = {
      type: 'error',
      source: 'cli' as const,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
      session_id: sessionId,
    };
    safeStdoutWrite(`${JSON.stringify(event)}\n`);
    return;
  }
  writeStderr(
    chalk.red(
      getI18n().t('commands:exec.errorDuringExecution', {
        message: getUserFacingError(error),
      })
    )
  );
}

// Build models help text dynamically - pass modelIds to avoid double API call
function buildModelsHelp(
  modelIds: ModelID[],
  customModels: Array<{ id: string; model: string; displayName?: string }> = []
): string {
  // Calculate max length for padding across both built-in and custom models
  const customModelsWithIds = customModels.filter((m) => Boolean(m.id));
  const allModelIds = [
    ...modelIds,
    ...customModelsWithIds.map((m) => m.id),
  ].filter(Boolean);
  const maxIdLen =
    allModelIds.length > 0 ? Math.max(...allModelIds.map((m) => m.length)) : 0;

  // Format built-in models
  const builtInLines = modelIds.map((m) => {
    const cfg = getModelConfig(m);
    const name = cfg?.displayName ?? m;
    const padded = m.padEnd(maxIdLen + 1, ' ');
    const isDefault = m === getDefaultModelId();
    return `  ${padded}  ${name}${isDefault ? ' (default)' : ''}`;
  });

  // Format custom models if any exist
  const customLines: string[] = [];
  if (customModels.length > 0) {
    customLines.push('');
    customLines.push(getI18n().t('commands:exec.customModels'));
    customModelsWithIds.forEach((m) => {
      const padded = m.id.padEnd(maxIdLen + 1, ' ');
      const displayName = m.displayName || '(custom)';
      customLines.push(`  ${padded}  ${displayName}`);
    });
  }

  return [...builtInLines, ...customLines].join('\n');
}

function buildModelDetailsHelp(modelIds: string[]): string {
  const header = 'Model details:';
  const entries = modelIds.map((m) => {
    const cfg = getModelConfig(m);
    const supported = cfg.supportedReasoningEfforts.join(', ');
    const supportsReasoning = cfg.supportedReasoningEfforts.some(
      (e: ReasoningEffort) => e !== ReasoningEffort.None
    );
    return `  - ${cfg.displayName}: supports reasoning: ${supportsReasoning ? 'Yes' : 'No'}; supported: [${supported}]; default: ${cfg.defaultReasoningEffort}`;
  });
  return [header, ...entries].join('\n');
}

// Async help display function that fetches actual available models
async function displayExecHelp(): Promise<void> {
  // Fetch available models once
  const modelIds = await getAvailableModelsForExec();

  // Get custom models from settings
  const customModels = getSettingsService().getCustomModels();

  const modelsHelp = buildModelsHelp(modelIds, customModels);
  const modelDetailsHelp = buildModelDetailsHelp(modelIds);

  const helpText = `Usage: drool exec [options] [prompt]

Execute a single command (non-interactive mode)

Arguments:
  prompt                      The prompt to execute

Options:
  -o, --output-format <format>  Output format (default: "text")
  --input-format <format>     Input format: stream-json for multi-turn sessions; stream-jsonrpc is controlled via JSON-RPC requests
  -f, --file <path>           Read prompt from file
  --auto <level>              Autonomy level: low|medium|high
  --skip-permissions-unsafe   Skip ALL permission checks - allows all permissions (unsafe)
  -s, --session-id <id>       Existing session to continue (requires a prompt)
  --fork <id>                 Fork an existing session into a new session (requires a prompt)
  -m, --model <id>            Model ID to use (default: ${getDefaultModelId()})
  -r, --reasoning-effort <level>  Reasoning effort (defaults per model)
  --spec-model <id>           Model ID to use for spec mode (defaults to main model)
  --spec-reasoning-effort <level>  Reasoning effort for spec mode (defaults per spec model)
  --use-spec                  Start in spec mode
  --enabled-tools <ids>       Enable specific tools (comma or space separated list)
  --disabled-tools <ids>      Disable specific tools (comma or space separated list)
  --cwd <path>                Working directory path
  -w, --worktree [name]       Run in a git worktree (name becomes branch; default: <current>-wt)
  --worktree-dir <path>       Directory for worktree creation
  --tag <spec>                Session tag (name or JSON, repeatable)
  --log-group-id <id>         Log group ID for filtering logs
  --mission                   Run in mission mode (orchestrate a multi-agent mission)
  --worker-model <id>         Model ID used by mission workers (only valid with --mission)
  --worker-reasoning-effort <level>  Reasoning effort for mission workers (only valid with --mission)
  --validator-model <id>      Model ID used by mission validation workers (only valid with --mission)
  --validator-reasoning-effort <level>  Reasoning effort for mission validation workers (only valid with --mission)
  --append-system-prompt <text>  Append custom text to the end of the system prompt
  --append-system-prompt-file <path>  Append file contents to the end of the system prompt
  --list-tools                List available tools for the selected model and exit
  -h, --help                  display help for command

Stream JSON-RPC Mode:
  CLI arguments ignored: -m/--model, --auto, -r/--reasoning-effort are ignored in stream-jsonrpc mode.
                             Control model, autonomy, and reasoning effort via the JSON-RPC requests instead.

Autonomy Levels:
  Drool exec uses a tiered autonomy system to control what operations the agent can perform.
  By default, it runs in read-only mode, requiring explicit flags to enable modifications.

  DEFAULT (no flags)         Read-only mode - The safest mode for reviewing planned changes without execution
                             • Reading files or logs: cat, less, head, tail, systemctl status
                             • Display commands: echo, pwd
                             • Information gathering: whoami, date, uname, ps, top
                             • Git read operations: git status, git log, git diff
                             • Directory listing: ls, find (without -delete or -exec)
                             ✗ No modifications to files or system
                             Use case: Safe for reviewing what changes would be made

  --auto low                 Low-risk operations - Basic file operations while blocking system changes
                             • File creation/modification in non-system directories: touch, mkdir, mv, cp
                             ✗ No system modifications or package installations
                             Use case: Documentation updates, code formatting, adding comments

  --auto medium              Development operations - Significant but recoverable side effects
                             • Installing packages from trusted sources: npm install, pip install (without sudo)
                             • Network requests to trusted endpoints: curl, wget to known APIs
                             • Git operations (local only): git commit, git checkout, git pull
                             • Building code: make, npm run build, mvn compile
                             ✗ No git push, sudo commands, or production changes
                             Use case: Local development, testing, dependency management

  --auto high                Production operations - Security implications or major side effects
                             • Running arbitrary/untrusted code: curl | bash, eval, downloaded scripts
                             • Exposing ports or modifying firewall rules
                             • Git push operations: git push, git push --force
                             • Production deployments, database migrations, sensitive operations
                             • Commands accessing/modifying passwords or keys
                             ✗ Still blocks: sudo rm -rf /, system-wide changes
                             Use case: CI/CD pipelines, automated deployments

  --skip-permissions-unsafe  Bypass all checks - DANGEROUS!
                             • Allows ALL operations without confirmation
                             • Can execute irreversible operations
                             • Only use in isolated environments (Docker, throwaway VMs)
                             ✗ Cannot be combined with --auto flags
                             Use case: Isolated environments only

Mission Mode:
  --mission                  Run in mission mode (multi-agent orchestration)
                             • Automatically upgrades session to orchestrator mode
                             • Spawns worker sessions via industryd to implement features
                             • Uses GPT-5.2 High reasoning by default (override with --model)
                             • Missions auto-approve proposals (no interactive confirmation)
                             • Requires --auto high or --skip-permissions-unsafe
                             Use case: Complex multi-step projects that benefit from parallel workers

Session Flags:
  --session-id <id>          Continue an existing session (requires a prompt)
                             Loads conversation history for context but does NOT replay old messages in output
  --fork <id>                Fork an existing session into a new local session (requires a prompt)
                             Copies conversation history first, then continues on the forked branch
  --tag <spec>               Session tag for categorization (repeatable)
                             Plain name: --tag code-review
                             JSON object: --tag '{"name":"code-review","metadata":{"prUrl":"..."}}'

Tool Controls:
  --list-tools               Print the tools available for the selected model and exit
  --enabled-tools <list>     Enable additional tools (comma or space separated identifiers)
  --disabled-tools <list>    Disable tools from the allowed set

Available Models:
${modelsHelp}

${modelDetailsHelp}

Authentication:
  Create an API key: https://app.example.com/settings/api-keys

  Setting API key examples:
    macOS/Linux:
      export INDUSTRY_API_KEY=fk-... && drool exec "fix the bug"
    Windows (PowerShell):
      $env:INDUSTRY_API_KEY="fk-..." ; drool exec "fix the bug"
    Windows (CMD):
      set INDUSTRY_API_KEY=fk-... && drool exec "fix the bug"

  Note: Keep your API key secret. Do not commit it to source control.

Examples:
  # DEFAULT (no flags) - Read-only mode for planning and analysis
  drool exec "Analyze the authentication system and create a detailed plan for migrating from session-based auth to OAuth2"
  drool exec "Review the codebase for security vulnerabilities and generate a prioritized list of improvements"
  drool exec "Analyze the project architecture and create a dependency graph"

  # --auto low - Safe file operations
  drool exec --auto low "add JSDoc comments to all functions"
  drool exec --auto low "fix typos in README.md"
  drool exec --auto low "format all Python files with black"

  # --auto medium - Development tasks
  drool exec --auto medium "install deps, run tests, fix issues"
  drool exec --auto medium "update packages and resolve conflicts"
  drool exec --auto medium "set up the development environment and run the test suite"

  # Tool discovery and overrides
  drool exec --list-tools
  drool exec --model gpt-5 --list-tools --output-format json
  drool exec --enabled-tools ApplyPatch "refactor files without raising autonomy"
  drool exec --auto medium --disabled-tools execute-cli "run edits without executing shell commands"

  # Using custom models
  drool exec --model custom:deepseek-v3 "analyze this code"
  drool exec --auto medium --model custom:qwen-turbo "implement this feature"

  # --auto high - Production operations
  drool exec --auto high "fix bug, test, commit, and push to main"
  drool exec --auto high "deploy to staging after running tests"
  drool exec --auto high "run database migration and update production config"

  # --mission - Multi-agent mission orchestration
  drool exec --mission --skip-permissions-unsafe "Build a full authentication system with OAuth2"
  drool exec --mission --auto high "Refactor the database layer to use connection pooling"
  drool exec --mission --auto high --model gpt-5 "Add comprehensive test coverage for the API layer"

  # --mission with per-run worker / validator model overrides
  drool exec --mission --auto high \\
    --model claude-opus-4-6 \\
    --worker-model claude-opus-4-6 --worker-reasoning-effort medium \\
    --validator-model gpt-5 --validator-reasoning-effort high \\
    "Refactor the auth system"

  # File input with different autonomy levels
  drool exec -f requirements.md
  drool exec -f task.md --auto low
  cat prompt.txt | drool exec --auto medium
  echo "analyze code" | drool exec

  # Session continuation (preserves context, no message replay)
  drool exec -s <session-id> "continue previous task"
  drool exec -s <session-id> "what did we discuss?"
  drool exec --fork <session-id> "take a different approach from here"

  # --skip-permissions-unsafe - Only in isolated environments!
  # In a Docker container:
  docker run --rm -v $(pwd):/workspace alpine:latest sh -c "
    drool exec --skip-permissions-unsafe 'Install system deps, modify configs, run tests'"

  # In ephemeral CI/CD runner:
  drool exec --skip-permissions-unsafe "Modify /etc/hosts, install kernel modules, reset network"
`;

  writeStdout(helpText);
}

const BUILTIN_SKILL_PREFIXES: Record<string, typeof BUILTIN_WIKI_SKILL> = {
  [`/${WIKI_COMMAND_NAME}`]: BUILTIN_WIKI_SKILL,
  [`/${INSTALL_WIKI_COMMAND_NAME}`]: BUILTIN_INSTALL_WIKI_SKILL,
};

/**
 * If the prompt starts with a builtin skill prefix (e.g. /wiki, /install-wiki),
 * wrap the skill's system prompt in a system notification so the agent executes
 * it immediately. Returns null when the prompt doesn't match any builtin skill.
 */
function resolveBuiltinSkillPrompt(trimmedPrompt: string): string | null {
  for (const [prefix, skill] of Object.entries(BUILTIN_SKILL_PREFIXES)) {
    if (!trimmedPrompt.toLowerCase().startsWith(prefix)) continue;
    const userText = trimmedPrompt.slice(prefix.length).trim();
    return (
      `${SYSTEM_NOTIFICATION_START}\n` +
      `Skills provide specialized capabilities and domain knowledge. The user has selected the following skill for immediate execution. Begin following the skill's instructions now.\n` +
      `<skill filePath="${skill.filePath}">\n` +
      `<name>${skill.metadata.name}</name>\n` +
      `<description>${skill.metadata.description || ''} (builtin)</description>\n` +
      `${skill.systemPrompt}\n` +
      `</skill>\n` +
      `${SYSTEM_NOTIFICATION_END}${userText ? `\n\n${userText}` : ''}`
    );
  }
  return null;
}

type ExecDeferredPromptResolver = typeof resolveDeferredPromptFromRawText;

export async function resolveExecPromptForAgent(
  prompt: string,
  addEphemeralSystemMessage: (content: string) => void = writeStderr,
  resolveDeferredPrompt: ExecDeferredPromptResolver = resolveDeferredPromptFromRawText
): Promise<string> {
  const trimmedPrompt = prompt.trim();
  const deferredPromptResult = await resolveDeferredPrompt(trimmedPrompt, {
    addEphemeralSystemMessage,
  });

  if (deferredPromptResult.status === 'failed') {
    throw new MetaError(deferredPromptResult.message);
  }

  if (deferredPromptResult.status === 'resolved') {
    return deferredPromptResult.result.messageText;
  }

  return resolveBuiltinSkillPrompt(trimmedPrompt) ?? prompt;
}

export async function runExecAction(
  prompt: string | undefined,
  options: ExecCommandOptions,
  startupTime?: number
): Promise<void> {
  // Mutable reference so the cleanup closure can access worktreeInfo
  // set later inside commandWrapper.
  let worktreeInfoRef: WorktreeSessionInfo | undefined;
  let worktreeCleanedUp = false;

  const doWorktreeCleanup = async (): Promise<void> => {
    if (worktreeCleanedUp || !worktreeInfoRef) return;
    worktreeCleanedUp = true;
    await cleanupWorktree(worktreeInfoRef, {
      print: (msg: string) => writeStderr(msg),
    });
  };

  const cleanup = async (): Promise<void> => {
    // Worktree cleanup is handled by shutdownCoordinator hook (signal path)
    // and the finally block inside commandWrapper's function body (normal/error path).
    // Do NOT clean up here — it races with shutdownCoordinator.
  };

  // Wrap everything in commandWrapper so SIG handling & telemetry flushing
  // mirror headless mode.
  await commandWrapper(async () => {
    try {
      // Handle help manually (now async to fetch feature flags)
      if (options.help) {
        await displayExecHelp();
        return;
      }

      // Set log group ID if provided
      if (options.logGroupId) {
        CliTelemetryClient.getInstance().setLogGroupId(options.logGroupId);
      }

      // Set request ID if provided
      if (options.requestId) {
        CliTelemetryClient.getInstance().setRequestId(options.requestId);
      }

      // Handle depth flag for subagent recursion limiting
      if (typeof options.depth === 'number' && options.depth >= 0) {
        getExecRuntimeConfig().setDepth(options.depth);
      }

      // Check mutual exclusivity of --worktree and --cwd
      if (options.worktree !== undefined && options.cwd !== undefined) {
        writeStderr(
          chalk.red('Error: --worktree and --cwd cannot be used together.')
        );
        throw new MetaError('--worktree and --cwd cannot be used together');
      }

      // Handle --worktree flag: create worktree before anything else
      let worktreeInfo: WorktreeSessionInfo | undefined;
      if (options.worktree !== undefined) {
        try {
          const worktreeDir =
            options.worktreeDir ?? getSettingsService().getWorktreeDirectory();
          worktreeInfo = await setupWorktree(options.worktree, {
            worktreeDir,
          });
          worktreeInfoRef = worktreeInfo;
          process.chdir(worktreeInfo.path);
          getExecRuntimeConfig().setWorktreeInfo(worktreeInfo);
          writeStderr(
            worktreeInfo.isNewlyCreated
              ? `Created worktree at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`
              : `Using existing worktree at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`
          );

          // Only auto-cleanup worktrees that drool created. Reused
          // worktrees (isNewlyCreated === false) must never be deleted.
          if (worktreeInfo.isNewlyCreated) {
            getShutdownCoordinator().registerHook(
              'worktree-cleanup',
              async () => {
                await doWorktreeCleanup();
              }
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          writeStderr(chalk.red(`Error: ${errorMessage}`));
          throw error instanceof Error ? error : new MetaError(String(error));
        }
      }

      // Configure Industry API for droolApi calls BEFORE any validation that may fetch settings
      configureIndustryApi(getIndustryApiConfig());

      // Validate options (print friendly error on failure)
      try {
        await assertValidOptions(options);
      } catch (validationError) {
        writeStderr(chalk.red(getUserFacingError(validationError)));
        throw validationError instanceof Error
          ? validationError
          : new MetaError(String(validationError));
      }

      // Start MCP early so dynamically registered MCP tools are available for
      // tool selection and --list-tools output; errors are non-fatal here.
      // For protocol modes, start non-blocking to avoid slow startup.
      // MCP status will be emitted via notifications when servers connect.
      const shouldStartMcpNonBlocking =
        options.inputFormat === 'stream-jsonrpc' ||
        options.outputFormat === OutputFormat.Acp ||
        options.outputFormat === OutputFormat.AcpDaemon;
      if (shouldStartMcpNonBlocking) {
        void getMcpService()
          .start()
          .catch(() => {
            // Errors handled by MCP status listeners
          });
      } else {
        try {
          await getMcpService().start();
        } catch (mcpError) {
          writeStderr(
            chalk.yellow(
              getI18n().t('commands:exec.mcpStartFailed', {
                message: getUserFacingError(mcpError),
              })
            )
          );
        }
      }

      getDroolRuntimeService().setDroolMode(DroolMode.NonInteractiveCLI);

      CliTelemetryClient.getInstance().setDroolMode(
        DroolMode.NonInteractiveCLI
      );

      // Determine tool selection based on flags/model
      let selection: ToolSelectionResult;
      try {
        selection = resolveToolSelection(options);
      } catch (selectionError) {
        writeStderr(chalk.red(getUserFacingError(selectionError)));
        throw selectionError instanceof Error
          ? selectionError
          : new MetaError(String(selectionError));
      }

      if (options.listTools) {
        printToolCatalog({
          selection,
          options,
          outputFormat:
            options.outputFormat === OutputFormat.StreamJson ||
            options.outputFormat === OutputFormat.Debug
              ? undefined
              : options.outputFormat,
        });
        for (const warning of selection.warnings) {
          writeStderr(chalk.yellow(warning));
        }
        return;
      }

      // Ensure the durable Task invocation store exists before any execution
      // mode runs, so subagent permission relay and background-wake recovery
      // have a stable file to read/write.
      ensureTaskInvocationStoreExists();

      // Check for ACP daemon mode (orchestrates multiple child processes)
      // Must be before session fetch - daemon manages sessions internally
      if (options.outputFormat === OutputFormat.AcpDaemon) {
        const { runAcpDaemon } = await import('@/exec/acpDaemonRunner');
        await withWorkingDirectory(options.cwd, async () => {
          await runAcpDaemon();
        });
        return;
      }

      // Check for ACP child mode (single session, receives auth from daemon)
      // Must be before session fetch - child creates session locally, not via API
      if (options.outputFormat === OutputFormat.Acp) {
        const { runAcpChild } = await import('@/exec/acpChildRunner');
        await withWorkingDirectory(options.cwd, async () => {
          if (options.sessionId && options.cwd) {
            await getSessionController().ensureSessionLoaded(
              options.sessionId,
              options.cwd
            );
            await changeSessionWorkingDirectory(process.cwd());
          }
          await runAcpChild({ sessionId: options.sessionId });
        });
        return;
      }

      // Validate request ID for remote sessions.
      let industryDroolSession = null;
      if (options.sessionId) {
        try {
          industryDroolSession = await droolApi.fetchSession(options.sessionId);
        } catch (error) {
          // 404 is expected for local-only sessions (e.g. subagent resume)
          const is404 = isFetchError(error) && error.response.status === 404;
          if (!is404) {
            throw new MetaError('Failed to fetch session', {
              sessionId: options.sessionId,
              cause: error,
            });
          }
        }

        // Validate requestId if provided
        if (industryDroolSession && options.requestId) {
          if (
            industryDroolSession.droolRequestId &&
            industryDroolSession.droolRequestId !== options.requestId
          ) {
            throw new MetaError('Request ID does not match session', {
              requestId: options.requestId,
              allowedValues: [industryDroolSession.droolRequestId],
            });
          }
        }
      }

      // Check for streaming input mode
      if (options.inputFormat === 'stream-json') {
        // Run streaming exec mode (deprecated)
        const { runStreamingExec } = await import('@/exec/streamingExecRunner');

        await withWorkingDirectory(options.cwd, async () => {
          const effectiveSessionId = options.fork
            ? await getSessionService().forkSession(
                options.fork,
                null,
                getForkSessionTitle(options.fork),
                options.fork,
                'fork',
                { cwdOverride: options.cwd ? process.cwd() : undefined }
              )
            : options.sessionId;

          // Configure exec runtime config for tool permissions
          const execCfg = getExecRuntimeConfig();
          execCfg.setAllowedToolIds(Array.from(selection.allowed));
          if (options.skipPermissionsUnsafe) {
            execCfg.setSkipAllConfirmations(true);
          }

          if (selection.warnings.length > 0) {
            for (const warning of selection.warnings) {
              writeStderr(chalk.yellow(warning));
            }
          }

          await runStreamingExec({
            sessionId: effectiveSessionId,
            cwd: options.cwd,
            options: {
              modelId: options.model,
              reasoningEffort: options.reasoningEffort,
              specModelId: options.specModel,
              specReasoningEffort: options.specReasoningEffort,
              useSpec: options.useSpec,
              autoLevel: options.auto,
              autonomyMode: getExecAutonomyMode(options),
            },
          });
        });
        return;
      }

      // Check for new JSON-RPC streaming input mode
      if (options.inputFormat === 'stream-jsonrpc') {
        // Run JSON-RPC streaming exec mode (V2)
        const { runStreamingJsonRpcExec } = await import(
          '@/exec/runStreamingJsonRpcExec'
        );

        await withWorkingDirectory(options.cwd, async () => {
          // JSON-RPC streaming mode has NO tool restrictions (like TUI)
          // This allows dynamic mode switching and full tool access
          if (options.skipPermissionsUnsafe) {
            getExecRuntimeConfig().setSkipAllConfirmations(true);
          }
          try {
            await runStreamingJsonRpcExec();
          } finally {
            // No session status management needed - handled by JSON-RPC protocol
          }
        });
        return;
      }

      // Resolve prompt (argument or stdin)
      let finalPrompt = await resolvePromptArg(prompt, options);

      // Handle /readiness-report slash command
      const trimmedPrompt = finalPrompt.trim();
      const readinessCommandPrefix = `/${READINESS_REPORT_COMMAND_NAME}`;
      let shouldLoadReadinessTools = false;
      if (trimmedPrompt.toLowerCase().startsWith(readinessCommandPrefix)) {
        // Extract custom instructions (everything after the command prefix)
        const customInstructions = trimmedPrompt
          .slice(readinessCommandPrefix.length)
          .trim();
        const args = customInstructions ? [customInstructions] : [];

        // Create minimal exec-compatible context
        const execContext = {
          addEphemeralSystemMessage: (content: string) => {
            // In exec mode, write messages to stderr
            writeStderr(content);
          },
          appExit: () => process.exit(0),
        };

        const result = await readinessReportCommand.execute(args, execContext);

        if (!result.shouldRunAgent || !result.messageText) {
          // Command handled but agent shouldn't run (e.g., validation error)
          return;
        }

        // Apply model/reasoning overrides only if user didn't provide their own
        finalPrompt = result.messageText;
        if (result.modelOverride && !options.model) {
          options.model = result.modelOverride;
        }
        if (result.reasoningEffortOverride && !options.reasoningEffort) {
          options.reasoningEffort = result.reasoningEffortOverride;
        }

        // Add the readiness report tool to the allowed set (it was excluded during initial selection)
        selection.allowed.add(storeAgentReadinessReportRemoteTool.id);
        shouldLoadReadinessTools = true;
      }

      await withWorkingDirectory(options.cwd, async () => {
        const effectiveSessionId = options.fork
          ? await getSessionService().forkSession(
              options.fork,
              null,
              getForkSessionTitle(options.fork),
              options.fork,
              'fork',
              { cwdOverride: options.cwd ? process.cwd() : undefined }
            )
          : options.sessionId;

        // Configure TUI exec runtime config for compatibility with the TUI path
        const execCfg = getExecRuntimeConfig();
        execCfg.setAllowedToolIds(Array.from(selection.allowed));
        if (options.skipPermissionsUnsafe) {
          execCfg.setSkipAllConfirmations(true);
        }

        if (selection.warnings.length > 0) {
          for (const warning of selection.warnings) {
            writeStderr(chalk.yellow(warning));
          }
        }

        // Set spec mode before creating session so session settings capture correct autonomy
        // Use setInteractionMode to preserve the autonomy level
        if (options.useSpec || options.specModel) {
          getSessionService().setInteractionMode(DroolInteractionMode.Spec);
        }

        // Use SessionController to manage session (creates or loads as needed)
        // This ensures conversation history is loaded properly like ACP/JSONRPC modes

        const sessionController = getSessionController();

        let sessionId: string;
        if (effectiveSessionId) {
          // Load existing session via SessionController (loads conversation history)
          await sessionController.ensureSessionLoaded(
            effectiveSessionId,
            options.cwd
          );
          if (options.cwd) {
            await changeSessionWorkingDirectory(process.cwd());
          }
          finalPrompt = await resolveExecPromptForAgent(finalPrompt);
          sessionId = effectiveSessionId;
        } else {
          finalPrompt = await resolveExecPromptForAgent(finalPrompt);
          // Create new session via SessionController
          const execTag = { name: DEFAULT_EXEC_TAG_NAME };
          const missionTag = { name: SESSION_TAG_MISSION_ORCHESTRATOR };
          const userTags = options.tag ?? [];
          const hasExecTag = userTags.some(
            (t) => t.name === DEFAULT_EXEC_TAG_NAME
          );
          const baseTags = hasExecTag ? userTags : [execTag, ...userTags];
          const tags = options.mission ? [missionTag, ...baseTags] : baseTags;
          sessionId = await sessionController.createSession({
            sessionId: options.initSessionId,
            cwd: options.cwd,
            tags,
            firstUserMessage: finalPrompt,
            callingSessionId: options.callingSessionId,
            callingToolUseId: options.callingToolUseId,
            sessionTitle: options.sessionTitle,
          });
        }

        if (shouldLoadReadinessTools) {
          // /readiness-report manually enables a deferred reporting tool
          // after initial selection; mark it loaded so its schema is sent.
          markReadinessToolsLoaded(sessionId);
        }

        // Measure execution duration
        const startTime = Date.now();

        // Map to track toolUseId -> toolId mappings for stream-json mode
        const toolUseIdMap = new Map<string, string>();

        // Subscribe to agentEventBus for stream-json mode
        const isStreamJsonMode =
          options.outputFormat === OutputFormat.StreamJson ||
          options.outputFormat === OutputFormat.Debug;
        const unsubscribeStreamJson = isStreamJsonMode
          ? subscribeToMultipleAgentEvents({
              [AgentEvent.UserMessage]: ({ message: msg, sessionId: sid }) => {
                for (const block of msg.content) {
                  if (block.type === MessageContentBlockType.Text) {
                    const text = block.text.trim();
                    if (text && !text.startsWith(SYSTEM_REMINDER_START)) {
                      const event: ExecEvent = {
                        type: 'message',
                        role: MessageRole.User,
                        id: msg.id,
                        text,
                        timestamp: msg.createdAt,
                        session_id: sid,
                      };
                      safeStdoutWrite(`${JSON.stringify(event)}\n`);
                    }
                  }
                }
              },
              [AgentEvent.AssistantMessage]: ({
                message: msg,
                sessionId: sid,
              }) => {
                const events = buildExecEventsFromAssistantMessage(
                  msg,
                  sid,
                  toolUseIdMap
                );
                for (const event of events) {
                  safeStdoutWrite(`${JSON.stringify(event)}\n`);
                }
              },
              [AgentEvent.ToolMessage]: ({ message: msg, sessionId: sid }) => {
                for (const block of msg.content) {
                  if (block.type === MessageContentBlockType.ToolResult) {
                    const value = String(block.content ?? '');
                    // Look up the tool ID using the toolUseId from our map
                    const toolId = toolUseIdMap.get(block.toolUseId) ?? '';
                    const event: ExecEvent = {
                      type: MessageContentBlockType.ToolResult,
                      id: block.toolUseId,
                      messageId: msg.id,
                      toolId,
                      isError: !!block.isError,
                      value: block.isError ? undefined : value,
                      error: block.isError
                        ? { type: 'tool_error', message: value }
                        : undefined,
                      timestamp: msg.createdAt,
                      session_id: sid,
                    };
                    safeStdoutWrite(`${JSON.stringify(event)}\n`);
                  }
                }
              },
              [AgentEvent.AgentError]: ({ error, sessionId: sid }) => {
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                const event: ExecEvent = {
                  type: 'error',
                  source: 'agent_loop',
                  message: errorMessage,
                  timestamp: Date.now(),
                  session_id: sid,
                };
                safeStdoutWrite(`${JSON.stringify(event)}\n`);
              },
            })
          : undefined;

        // Emit system init event ONCE for stream-json mode
        if (isStreamJsonMode) {
          const tools = getRegisteredTools();
          const toolNames = tools.map((t) => t.llmId || t.id);
          const resolvedModel = options.model || getDefaultModelId();
          const resolvedReasoningEffort =
            options.reasoningEffort ||
            getModelDefaultReasoningEffort(resolvedModel);
          const systemInitEvent: ExecEvent = {
            type: 'system',
            subtype: 'init',
            cwd: process.cwd(),
            session_id: sessionId,
            tools: toolNames,
            model: resolvedModel,
            reasoning_effort: resolvedReasoningEffort,
          };
          safeStdoutWrite(`${JSON.stringify(systemInitEvent)}\n`);
        }

        try {
          // Mission mode: upgrade session to orchestrator and configure Mission mode
          if (options.mission) {
            const sessionService = getSessionService();
            await sessionService.upgradeToOrchestratorSession();
            sessionService.setInteractionMode(DroolInteractionMode.Mission);

            // Apply per-run mission worker / validator model overrides
            const missionOverrides: MissionModelSettings = {};
            if (options.workerModel !== undefined) {
              missionOverrides.workerModel = options.workerModel;
            }
            if (options.workerReasoningEffort !== undefined) {
              missionOverrides.workerReasoningEffort =
                options.workerReasoningEffort;
            }
            if (options.validatorModel !== undefined) {
              missionOverrides.validationWorkerModel = options.validatorModel;
            }
            if (options.validatorReasoningEffort !== undefined) {
              missionOverrides.validationWorkerReasoningEffort =
                options.validatorReasoningEffort;
            }
            if (Object.keys(missionOverrides).length > 0) {
              const missionFileService = getMissionFileService(sessionId);
              await missionFileService.initializeMissionDir();
              await missionFileService.writeModelSettings(missionOverrides);
              sessionService.setMissionSettings({
                ...getSettingsService().getMissionModelSettings(),
                ...missionOverrides,
              });
            }
          }

          // Log total startup latency RIGHT BEFORE runRenderlessExec
          if (startupTime !== undefined) {
            Metrics.addToCounter(
              Metric.CLI_STARTUP_TOTAL_LATENCY,
              performance.now() - startupTime,
              getCliRuntimeMetricLabels()
            );
          }

          // Mission mode: dedicated preamble + orchestrator prompt
          let systemPrompt = options.mission
            ? `${MISSION_EXEC_SYSTEM_PROMPT}\n\n${getOrchestratorSystemPrompt()}`
            : EXEC_SYSTEM_PROMPT;
          const defaultMissionOrchestratorModel =
            getSettingsService().getMissionOrchestratorModel();
          const defaultMissionOrchestratorReasoningEffort =
            getSettingsService().getMissionOrchestratorReasoningEffort();

          // Append custom system prompt text if provided via --append-system-prompt
          const appendText = getExecRuntimeConfig().getAppendSystemPrompt();
          if (appendText) {
            systemPrompt = `${systemPrompt}\n\n${appendText}`;
          }

          // Run the drool via TUI renderless exec
          const result = await runRenderlessExec({
            sessionId,
            prompt: finalPrompt,
            opts: {
              modelId: options.mission
                ? (options.model ?? defaultMissionOrchestratorModel)
                : options.model,
              reasoningEffort: options.mission
                ? (options.reasoningEffort ??
                  defaultMissionOrchestratorReasoningEffort)
                : options.reasoningEffort,
              specModelId: options.specModel,
              specReasoningEffort: options.specReasoningEffort,
              useSpec: options.useSpec,
              autoLevel: options.auto,
              autonomyMode: getExecAutonomyMode(options),
            },
            systemPromptOverride: systemPrompt,
          });
          const durationMs = Date.now() - startTime;

          // Treat runner-surfaced errors (auth, early-termination, fatal) as failures
          if (result.isError) {
            throw new MetaError(result.finalText || 'Exec failed');
          }
          printSuccessOutput(result, durationMs, options.outputFormat);
        } catch (error) {
          printErrorOutput(options.outputFormat, sessionId, startTime, error);
          // propagate failure so commandWrapper sets exit code
          throw error instanceof Error ? error : new MetaError(String(error));
        } finally {
          // Clean up stream-json event subscriptions
          unsubscribeStreamJson?.();
        }
      });
    } catch (error) {
      // Re-throw so commandWrapper treats as failure
      throw error instanceof Error ? error : new MetaError(String(error));
    }
  }, cleanup); // end commandWrapper
}
