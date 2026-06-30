import { ToolExecutionErrorType } from '@industry/common/session';
import { ToolSearchParams } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
  LLMToolDescriptor,
} from '@industry/drool-core/tools/types';

import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

const FALLBACK_SESSION_KEY = '__no_session__';
let toolRegistryBySessionId = new Map<string, LLMToolDescriptor[]>();

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'Execute',
  shell: 'Execute',
  runcommand: 'Execute',
  executecommand: 'Execute',
  exec: 'Execute',
  run: 'Execute',
  terminal: 'Execute',
  bashtool: 'Execute',
  bash_tool: 'Execute',
  'bash-tool': 'Execute',
  run_command: 'Execute',
  'run-command': 'Execute',
  execute_command: 'Execute',
  'execute-command': 'Execute',
  execute_terminal_command: 'Execute',
  'execute-terminal-command': 'Execute',
  execute_cli: 'Execute',
  'execute-cli': 'Execute',
  command: 'Execute',
  readfile: 'Read',
  fileread: 'Read',
  file_read: 'Read',
  read_file: 'Read',
  'read-file': 'Read',
  read_cli: 'Read',
  'read-cli': 'Read',
  view_file: 'Read',
  'view-file': 'Read',
  open_file: 'Read',
  'open-file': 'Read',
  cat: 'Read',
  write: 'Create',
  writefile: 'Create',
  write_file: 'Create',
  'write-file': 'Create',
  createfile: 'Create',
  create_file: 'Create',
  'create-file': 'Create',
  create_cli: 'Create',
  'create-cli': 'Create',
  editfile: 'Edit',
  edit_file: 'Edit',
  'edit-file': 'Edit',
  edit_cli: 'Edit',
  'edit-cli': 'Edit',
  multiedit: 'Edit',
  multi_edit: 'Edit',
  'multi-edit': 'Edit',
  apply_patch: 'ApplyPatch',
  'apply-patch': 'ApplyPatch',
  apply_patch_cli: 'ApplyPatch',
  'apply-patch-cli': 'ApplyPatch',
  grep_tool: 'Grep',
  'grep-tool': 'Grep',
  greptool: 'Grep',
  grep_tool_cli: 'Grep',
  grep_search_cli: 'Grep',
  'grep-search-cli': 'Grep',
  rg: 'Grep',
  ripgrep: 'Grep',
  glob_tool: 'Glob',
  'glob-tool': 'Glob',
  globtool: 'Glob',
  glob_search_cli: 'Glob',
  'glob-search-cli': 'Glob',
  search_files: 'Glob',
  'search-files': 'Glob',
  searchfiles: 'Glob',
  listfiles: 'LS',
  list_files: 'LS',
  'list-files': 'LS',
  list_folder: 'LS',
  'list-folder': 'LS',
  listfolder: 'LS',
  view_folder: 'LS',
  'view-folder': 'LS',
  viewfolder: 'LS',
  ls_cli: 'LS',
  'ls-cli': 'LS',
  web_search: 'WebSearch',
  'web-search': 'WebSearch',
  websearch: 'WebSearch',
  fetch: 'FetchUrl',
  fetch_url: 'FetchUrl',
  'fetch-url': 'FetchUrl',
  fetchurl: 'FetchUrl',
  ask_user: 'AskUser',
  'ask-user': 'AskUser',
  ask_user_cli: 'AskUser',
  'ask-user-cli': 'AskUser',
  askuser: 'AskUser',
  todo_write: 'TodoWrite',
  'todo-write': 'TodoWrite',
  todowrite: 'TodoWrite',
  exit_spec_mode: 'ExitSpecMode',
  'exit-spec-mode': 'ExitSpecMode',
  exit_spec: 'ExitSpecMode',
  'exit-spec': 'ExitSpecMode',
  spec_mode: 'ExitSpecMode',
  'spec-mode': 'ExitSpecMode',
  generate_drool: 'GenerateDrool',
  'generate-drool': 'GenerateDrool',
  generate_drool_cli: 'GenerateDrool',
  'generate-drool-cli': 'GenerateDrool',
  task_cli: 'Task',
  'task-cli': 'Task',
  subagent: 'Task',
  sub_agent: 'Task',
  'sub-agent': 'Task',
  task_output: 'TaskOutput',
  'task-output': 'TaskOutput',
  task_output_cli: 'TaskOutput',
  'task-output-cli': 'TaskOutput',
  task_stop: 'TaskStop',
  'task-stop': 'TaskStop',
  task_stop_cli: 'TaskStop',
  'task-stop-cli': 'TaskStop',
  tool_search: 'ToolSearch',
  'tool-search': 'ToolSearch',
  tool_search_cli: 'ToolSearch',
  'tool-search-cli': 'ToolSearch',
  skill_cli: 'Skill',
  'skill-cli': 'Skill',
  squad_board: 'squad-board',
  squadboard: 'squad-board',
  propose_mission: 'ProposeMission',
  'propose-mission': 'ProposeMission',
  start_mission_run: 'StartMissionRun',
  'start-mission-run': 'StartMissionRun',
  end_feature_run: 'EndFeatureRun',
  'end-feature-run': 'EndFeatureRun',
  dismiss_handoff_items: 'DismissHandoffItems',
  'dismiss-handoff-items': 'DismissHandoffItems',
  store_agent_readiness_report_remote: 'store_agent_readiness_report',
  'store-agent-readiness-report': 'store_agent_readiness_report',
  get_agent_effectiveness_usage_remote: 'get_agent_effectiveness_usage',
  'get-agent-effectiveness-usage': 'get_agent_effectiveness_usage',
  render_agent_effectiveness_report_remote: 'render_agent_effectiveness_report',
  'render-agent-effectiveness-report': 'render_agent_effectiveness_report',
  slack: 'slack_post_message',
  'slack-post-message': 'slack_post_message',
  'slack-post-file': 'slack_post_file',
  slack_file: 'slack_post_file',
  slack___post_file: 'slack_post_file',
  slack___files_upload: 'slack_post_file',
  slack___files_complete_upload_external: 'slack_post_file',
  slack___post_message: 'slack_post_message',
  slack___send_message: 'slack_post_message',
  slack___message_send: 'slack_post_message',
  slack___chat_postmessage: 'slack_post_message',
  slack___chat_post_message: 'slack_post_message',
};

function getSessionKey(sessionId: string | null | undefined): string {
  return sessionId ?? FALLBACK_SESSION_KEY;
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function getToolNameEntry(
  requestedName: string,
  canonicalName: string
): string {
  return requestedName === canonicalName
    ? canonicalName
    : `${canonicalName} (requested as ${requestedName})`;
}

function formatNotFoundMessage(names: string[]): string {
  return `Not found: ${names.join(', ')}. Only request exact tool names from the Deferred tools list in the latest system reminder. If the needed tool is not listed and is not already available, it is unavailable in this session; do not retry ToolSearch for ${names.length === 1 ? 'this name' : 'these names'}.`;
}

function findDescriptor(
  registry: LLMToolDescriptor[],
  requestedName: string
): LLMToolDescriptor | undefined {
  const normalizedName = normalizeToolName(requestedName);
  const exactMatch = registry.find(
    (tool) => normalizeToolName(tool.spec.name) === normalizedName
  );

  if (exactMatch) {
    return exactMatch;
  }

  const canonicalAlias = TOOL_NAME_ALIASES[normalizedName];
  if (!canonicalAlias) {
    return undefined;
  }

  return registry.find(
    (tool) =>
      normalizeToolName(tool.spec.name) === normalizeToolName(canonicalAlias)
  );
}

/**
 * Call this at each LLM request to keep the executor's view of available tools current.
 */
export function setDeferredToolsForSearch(
  sessionId: string | null | undefined,
  tools: LLMToolDescriptor[]
): void {
  toolRegistryBySessionId.set(getSessionKey(sessionId), tools);
}

export function resetDeferredToolsForSearch(): void {
  toolRegistryBySessionId = new Map<string, LLMToolDescriptor[]>();
}

export class ToolSearchCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: ToolSearchParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    const { query } = parameters;

    if (!query || typeof query !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'query is required. Use format: "select:<name>[,<name>...]"',
        userError: 'Invalid ToolSearch query',
      };
      return;
    }

    // Parse select:name1,name2 format
    const selectMatch = query.match(/^select:(.+)$/i);
    if (!selectMatch) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'Invalid query format. Use: "select:<name>[,<name>...]"',
        userError: 'Invalid ToolSearch query format',
      };
      return;
    }

    const requestedNames = selectMatch[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);

    if (requestedNames.length === 0) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'No tool names provided after "select:"',
        userError: 'No tool names in query',
      };
      return;
    }

    const service = getDeferredToolsService();
    const sessionId = dependencies.sessionId;
    const toolRegistry =
      toolRegistryBySessionId.get(getSessionKey(sessionId)) ?? [];
    const loaded: string[] = [];
    const alreadyLoaded: string[] = [];
    const alreadyAvailable: string[] = [];
    const notFound: string[] = [];

    for (const name of requestedNames) {
      const descriptor = findDescriptor(toolRegistry, name);
      if (!descriptor) {
        notFound.push(name);
        continue;
      }

      const canonicalName = descriptor.spec.name;
      const entry = getToolNameEntry(name, canonicalName);
      if (!descriptor.deferred) {
        alreadyAvailable.push(entry);
        continue;
      }
      if (service.isLoaded(sessionId, canonicalName)) {
        alreadyLoaded.push(entry);
        continue;
      }
      service.markLoaded(sessionId, canonicalName);
      loaded.push(entry);
    }

    const parts: string[] = [];
    if (loaded.length > 0) {
      parts.push(`Loaded ${loaded.length} tool(s): ${loaded.join(', ')}`);
    }
    if (alreadyLoaded.length > 0) {
      parts.push(
        `Already loaded ${alreadyLoaded.length} tool(s): ${alreadyLoaded.join(', ')}. These are in your tool list now; call them directly. Do not use ToolSearch for tools you have already loaded.`
      );
    }
    if (alreadyAvailable.length > 0) {
      parts.push(
        `Already available ${alreadyAvailable.length} tool(s): ${alreadyAvailable.join(', ')}. Call these tools directly; ToolSearch only loads deferred tools.`
      );
    }
    if (notFound.length > 0) {
      parts.push(formatNotFoundMessage(notFound));
    }

    const resolvedCount =
      loaded.length + alreadyLoaded.length + alreadyAvailable.length;
    if (notFound.length > 0 && resolvedCount === 0) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: parts.join('\n\n'),
        userError: 'Tool(s) not found',
      };
    } else {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: parts.join('\n\n'),
      };
    }
  }
}
