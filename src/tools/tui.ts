import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  todoWriteTool,
  applyPatchCliTool,
  createCliTool,
  editCliTool,
  grepSearchCliTool,
  globSearchCliTool,
  lsCliTool,
  readCliTool,
  generateDroolCliTool,
  exitSpecModeTool,
  askUserTool,
  webSearchTool,
  fetchUrlTool,
  slackPostFileTool,
  slackPostMessageTool,
  storeAgentReadinessReportRemoteTool,
  getAgentEffectivenessUsageTool,
  renderAgentEffectivenessReportTool,
  skillTool,
  proposeMissionTool,
  startMissionRunTool,
  endFeatureRunTool,
  dismissHandoffItemsTool,
  squadBoardTool,
  taskOutputCliTool,
  taskStopCliTool,
  toolSearchCliTool,
  upgradeSessionModelCliTool,
  connectorSearchTool,
} from '@industry/drool-core/tools/definitions';
import { executeCliWithBackgroundTool } from '@industry/drool-core/tools/definitions/cli/executeCliWithBackground';
import { logException } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';

import { ApplyPatchCliExecutor } from '@/tools/executors/client/apply-patch-cli';
import { AskUserExecutor } from '@/tools/executors/client/ask-user';
import { ConnectorSearchCliExecutor } from '@/tools/executors/client/connectors/connector-search-cli';
import { CreateCliExecutor } from '@/tools/executors/client/create-cli';
import { EditCliExecutor } from '@/tools/executors/client/edit-cli';
import { ExecuteCliExecutor } from '@/tools/executors/client/execute-cli';
import { ExitSpecModeExecutor } from '@/tools/executors/client/exit-spec-mode';
import { FetchUrlExecutor } from '@/tools/executors/client/fetch-url-cli';
import { GenerateDroolCliExecutor } from '@/tools/executors/client/generate-drool-cli';
import { GetAgentEffectivenessUsageCliExecutor } from '@/tools/executors/client/get-agent-effectiveness-usage-cli';
import { CliGlobSearchExecutor } from '@/tools/executors/client/glob-search-cli';
import { GrepSearchCliExecutor } from '@/tools/executors/client/grep-search-cli';
import { LsCliExecutor } from '@/tools/executors/client/ls-cli';
import { DismissHandoffItemsExecutor } from '@/tools/executors/client/mission/dismiss-handoff-items';
import { EndFeatureRunExecutor } from '@/tools/executors/client/mission/end-feature-run';
import { ProposeMissionExecutor } from '@/tools/executors/client/mission/propose-mission';
import { StartMissionRunExecutor } from '@/tools/executors/client/mission/start-mission-run';
import { ReadCliExecutor } from '@/tools/executors/client/read-cli';
import { RenderAgentEffectivenessReportCliExecutor } from '@/tools/executors/client/render-agent-effectiveness-report-cli';
import { UpgradeSessionModelExecutor } from '@/tools/executors/client/session-model-upgrade';
import { SlackPostFileCliExecutor } from '@/tools/executors/client/slack/slack-post-file-cli';
import { SlackPostMessageCliExecutor } from '@/tools/executors/client/slack/slack-post-message-cli';
import { SquadBoardExecutor } from '@/tools/executors/client/squad-board-executor';
import { StoreAgentReadinessReportCliExecutor } from '@/tools/executors/client/store-agent-readiness-report-cli';
import { TaskOutputCliExecutor } from '@/tools/executors/client/task-output-cli';
import { TaskStopCliExecutor } from '@/tools/executors/client/task-stop-cli';
import { TodoWriteCliExecutor } from '@/tools/executors/client/todo-write-cli';
import { ToolSearchCliExecutor } from '@/tools/executors/client/tool-search-cli';
import { WebSearchExecutor } from '@/tools/executors/client/web-search';
import { SkillExecutor } from '@/tools/executors/SkillExecutor';
import { initializeTaskToolManager } from '@/tools/managers/taskToolManager';
import { getTUIToolRegistry } from '@/tools/registry';

getTUIToolRegistry().register({
  tool: readCliTool,
  executorIndustry: () => new ReadCliExecutor(),
});

getTUIToolRegistry().register({
  tool: lsCliTool,
  executorIndustry: () => new LsCliExecutor(),
});

getTUIToolRegistry().register({
  tool: executeCliWithBackgroundTool,
  executorIndustry: () => new ExecuteCliExecutor(),
});

getTUIToolRegistry().register({
  tool: editCliTool,
  executorIndustry: () => new EditCliExecutor(),
});

getTUIToolRegistry().register({
  tool: applyPatchCliTool,
  executorIndustry: () => new ApplyPatchCliExecutor(),
});

getTUIToolRegistry().register({
  tool: grepSearchCliTool,
  executorIndustry: () => new GrepSearchCliExecutor(),
});

getTUIToolRegistry().register({
  tool: globSearchCliTool,
  executorIndustry: () => new CliGlobSearchExecutor(),
});

getTUIToolRegistry().register({
  tool: createCliTool,
  executorIndustry: () => new CreateCliExecutor(),
});

getTUIToolRegistry().register({
  tool: exitSpecModeTool,
  executorIndustry: () => new ExitSpecModeExecutor(),
});

getTUIToolRegistry().register({
  tool: askUserTool,
  executorIndustry: () => new AskUserExecutor(),
});

getTUIToolRegistry().register({
  tool: webSearchTool,
  executorIndustry: () => new WebSearchExecutor(),
});

getTUIToolRegistry().register({
  tool: todoWriteTool,
  executorIndustry: () => new TodoWriteCliExecutor(),
});

getTUIToolRegistry().register({
  tool: fetchUrlTool,
  executorIndustry: () => new FetchUrlExecutor(),
});

getTUIToolRegistry().register({
  tool: squadBoardTool,
  executorIndustry: () => new SquadBoardExecutor(),
});

getTUIToolRegistry().register({
  tool: slackPostFileTool,
  executorIndustry: () => new SlackPostFileCliExecutor(),
});

getTUIToolRegistry().register({
  tool: slackPostMessageTool,
  executorIndustry: () => new SlackPostMessageCliExecutor(),
});

getTUIToolRegistry().register({
  tool: storeAgentReadinessReportRemoteTool,
  executorIndustry: () => new StoreAgentReadinessReportCliExecutor(),
});

getTUIToolRegistry().register({
  tool: getAgentEffectivenessUsageTool,
  executorIndustry: () => new GetAgentEffectivenessUsageCliExecutor(),
});

getTUIToolRegistry().register({
  tool: renderAgentEffectivenessReportTool,
  executorIndustry: () => new RenderAgentEffectivenessReportCliExecutor(),
});

getTUIToolRegistry().register({
  tool: generateDroolCliTool,
  executorIndustry: () => new GenerateDroolCliExecutor(),
});

getTUIToolRegistry().register({
  tool: upgradeSessionModelCliTool,
  executorIndustry: () => new UpgradeSessionModelExecutor(),
});

// Connectors (Merge Agent Handler) tool is registered dynamically based on the connectors flag
export function registerConnectorsTools(): void {
  if (!getFlag(IndustryFeatureFlags.Connectors)) {
    return;
  }

  getTUIToolRegistry().register({
    tool: connectorSearchTool,
    executorIndustry: () => new ConnectorSearchCliExecutor(),
  });
}

// TaskOutput and TaskStop are registered dynamically based on sub-agents-v2 flag
export function registerSubAgentsV2Tools(): void {
  getTUIToolRegistry().register({
    tool: taskOutputCliTool,
    executorIndustry: () => new TaskOutputCliExecutor(),
  });

  getTUIToolRegistry().register({
    tool: taskStopCliTool,
    executorIndustry: () => new TaskStopCliExecutor(),
  });
}

// Initialize dynamic task tool registration without blocking module load
void initializeTaskToolManager().catch((error) => {
  logException(error, '[TaskToolManager] Failed to initialize (module load)');
});

// ToolSearch — client-side deferred tool loader (only meaningful when feature flag is on,
// but always registered; filtering happens in generateToolsFromRegistry based on deferred flag)
getTUIToolRegistry().register({
  tool: toolSearchCliTool,
  executorIndustry: () => new ToolSearchCliExecutor(),
});

// Register Skill tool statically - filtering happens in generateToolsFromRegistry
getTUIToolRegistry().register({
  tool: skillTool,
  executorIndustry: () => new SkillExecutor(),
});

// Mission decomposition tools
getTUIToolRegistry().register({
  tool: proposeMissionTool,
  executorIndustry: () => new ProposeMissionExecutor(),
});

getTUIToolRegistry().register({
  tool: startMissionRunTool,
  executorIndustry: () => new StartMissionRunExecutor(),
});

getTUIToolRegistry().register({
  tool: endFeatureRunTool,
  executorIndustry: () => new EndFeatureRunExecutor(),
});

getTUIToolRegistry().register({
  tool: dismissHandoffItemsTool,
  executorIndustry: () => new DismissHandoffItemsExecutor(),
});

export async function ensureTaskToolManagerInitialized(): Promise<void> {
  try {
    await initializeTaskToolManager();
  } catch (error) {
    logException(error, '[TaskToolManager] Failed to initialize (ensure call)');
  }
}
