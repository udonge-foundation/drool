import {
  DaemonConnectionMethod,
  DaemonDroolMethod,
  DaemonManagementMethod,
  DaemonRelayMethod,
  DaemonSettingsMethod,
  DaemonTerminalMethod,
} from '@industry/common/daemon';
import {
  InProcessDaemonMethodNotFoundError,
  type DaemonClient,
} from '@industry/daemon-client';
import { type JsonRpcBaseRequest } from '@industry/drool-sdk-ext/protocol/shared';

import type { InProcessDaemonRuntime } from '@/services/daemon/InProcessDaemonRuntime';

// TODO: Delete this dispatcher once daemon capabilities are composable and the
// TUI parent runtime can use daemon-core's RequestDispatcher directly.
export class InProcessDaemonDispatcher {
  private readonly runtime: InProcessDaemonRuntime;

  constructor(runtime: InProcessDaemonRuntime) {
    this.runtime = runtime;
  }

  async handleRequest({
    id,
    method,
    params,
  }: JsonRpcBaseRequest): Promise<unknown> {
    switch (method) {
      case DaemonConnectionMethod.AUTHENTICATE:
        return this.runtime.authenticate(
          params as Parameters<DaemonClient['authenticate']>[0]
        );
      case DaemonConnectionMethod.LOGOUT:
        return this.runtime.logout();

      case DaemonDroolMethod.INITIALIZE_SESSION:
        return this.runtime.initializeSession(
          params as Parameters<DaemonClient['initializeSession']>[0]
        );
      case DaemonDroolMethod.LOAD_SESSION:
        return this.runtime.loadSession(
          params as Parameters<DaemonClient['loadSession']>[0]
        );
      case DaemonDroolMethod.ADD_USER_MESSAGE:
        return this.runtime.addUserMessage(
          params as Parameters<DaemonClient['addUserMessage']>[0],
          id
        );
      case DaemonDroolMethod.RESOLVE_QUEUED_USER_MESSAGE:
        return this.runtime.resolveQueuedUserMessage(
          params as Parameters<DaemonClient['resolveQueuedUserMessage']>[0]
        );
      case DaemonDroolMethod.INTERRUPT_SESSION:
        return this.runtime.interruptSession(
          params as Parameters<DaemonClient['interruptSession']>[0]
        );
      case DaemonDroolMethod.CLOSE_SESSION:
        return this.runtime.closeSession(
          params as Parameters<DaemonClient['closeSession']>[0]
        );
      case DaemonDroolMethod.KILL_WORKER_SESSION:
        return this.runtime.killWorkerSession(
          params as Parameters<DaemonClient['killWorkerSession']>[0]
        );
      case DaemonDroolMethod.UPDATE_SESSION_SETTINGS:
        return this.runtime.updateSessionSettings(
          params as Parameters<DaemonClient['updateSessionSettings']>[0],
          id
        );
      case DaemonDroolMethod.LIST_CRONS:
        return this.runtime.listCrons(
          params as Parameters<DaemonClient['listCrons']>[0]
        );
      case DaemonDroolMethod.CREATE_CRON:
        return this.runtime.createCron(
          params as Parameters<DaemonClient['createCron']>[0]
        );
      case DaemonDroolMethod.UPDATE_CRON:
        return this.runtime.updateCron(
          params as Parameters<DaemonClient['updateCron']>[0]
        );
      case DaemonDroolMethod.DELETE_CRON:
        return this.runtime.deleteCron(
          params as Parameters<DaemonClient['deleteCron']>[0]
        );
      case DaemonDroolMethod.HOLD_SESSION_CRONS:
        return this.runtime.holdSessionCrons(
          params as Parameters<DaemonClient['holdSessionCrons']>[0]
        );
      case DaemonDroolMethod.RESUME_SESSION_CRONS:
        return this.runtime.resumeSessionCrons(
          params as Parameters<DaemonClient['resumeSessionCrons']>[0]
        );
      case DaemonDroolMethod.VALIDATE_WORKING_DIRECTORY:
        return this.runtime.validateWorkingDirectory(
          params as Parameters<DaemonClient['validateWorkingDirectory']>[0]
        );

      case DaemonSettingsMethod.GET_DEFAULT_SETTINGS:
        return this.runtime.getDefaultSettings();
      case DaemonSettingsMethod.UPDATE_SESSION_DEFAULTS:
        return this.runtime.updateSessionDefaults(
          params as Parameters<DaemonClient['updateSessionDefaults']>[0]
        );

      case DaemonManagementMethod.TRIGGER_UPDATE:
        return this.runtime.triggerUpdate();
      case DaemonManagementMethod.INSTALL_SSH_KEY:
        return this.runtime.installSshKey();

      case DaemonRelayMethod.START:
        return this.runtime.startRelay();
      case DaemonRelayMethod.STOP:
        return this.runtime.stopRelay();
      case DaemonRelayMethod.GET_STATUS:
        return this.runtime.getRelayStatus();

      case DaemonTerminalMethod.CREATE:
        return this.runtime.createTerminal(
          params as Parameters<DaemonClient['createTerminal']>[0]
        );
      case DaemonTerminalMethod.WRITE_DATA:
        return this.runtime.writeTerminalData(
          params as Parameters<DaemonClient['writeTerminalData']>[0]
        );
      case DaemonTerminalMethod.RESIZE:
        return this.runtime.resizeTerminal(
          params as Parameters<DaemonClient['resizeTerminal']>[0]
        );
      case DaemonTerminalMethod.CLOSE:
        return this.runtime.closeTerminal(
          params as Parameters<DaemonClient['closeTerminal']>[0]
        );
      case DaemonTerminalMethod.LIST:
        return this.runtime.listTerminals(
          params as Parameters<DaemonClient['listTerminals']>[0]
        );

      case DaemonDroolMethod.LIST_FILES:
        return this.runtime.listFiles(
          params as Parameters<DaemonClient['listFiles']>[0]
        );
      case DaemonDroolMethod.SEARCH_FILES:
        return this.runtime.searchFiles(
          params as Parameters<DaemonClient['searchFiles']>[0]
        );
      case DaemonDroolMethod.SEARCH_SESSIONS:
        return this.runtime.searchSessions(
          params as Parameters<DaemonClient['searchSessions']>[0]
        );
      case DaemonDroolMethod.GET_MCP_CONFIG:
        return this.runtime.getMcpConfig();
      case DaemonDroolMethod.UPDATE_MCP_CONFIG:
        return this.runtime.updateMcpConfig(
          params as Parameters<DaemonClient['updateMcpConfig']>[0]
        );
      case DaemonDroolMethod.TOGGLE_MCP_SERVER:
        return this.runtime.toggleMcpServer(
          params as Parameters<DaemonClient['toggleMcpServer']>[0]
        );
      case DaemonDroolMethod.AUTHENTICATE_MCP_SERVER:
        return this.runtime.authenticateMcpServer(
          params as Parameters<DaemonClient['authenticateMcpServer']>[0]
        );
      case DaemonDroolMethod.CLEAR_MCP_AUTH:
        return this.runtime.clearMcpAuth(
          params as Parameters<DaemonClient['clearMcpAuth']>[0]
        );
      case DaemonDroolMethod.CANCEL_MCP_AUTH:
        return this.runtime.cancelMcpAuth(
          params as Parameters<DaemonClient['cancelMcpAuth']>[0]
        );
      case DaemonDroolMethod.ADD_MCP_SERVER:
        return this.runtime.addMcpServer(
          params as Parameters<DaemonClient['addMcpServer']>[0]
        );
      case DaemonDroolMethod.REMOVE_MCP_SERVER:
        return this.runtime.removeMcpServer(
          params as Parameters<DaemonClient['removeMcpServer']>[0]
        );
      case DaemonDroolMethod.LIST_MCP_REGISTRY:
        return this.runtime.listMcpRegistry(
          params as Parameters<DaemonClient['listMcpRegistry']>[0]
        );
      case DaemonDroolMethod.LIST_MCP_TOOLS:
        return this.runtime.listMcpTools(
          params as Parameters<DaemonClient['listMcpTools']>[0]
        );
      case DaemonDroolMethod.LIST_MCP_SERVERS:
        return this.runtime.listMcpServers(
          params as Parameters<DaemonClient['listMcpServers']>[0]
        );
      case DaemonDroolMethod.TOGGLE_MCP_TOOL:
        return this.runtime.toggleMcpTool(
          params as Parameters<DaemonClient['toggleMcpTool']>[0]
        );
      case DaemonDroolMethod.SUBMIT_MCP_AUTH_CODE:
        return this.runtime.submitMcpAuthCode(
          params as Parameters<DaemonClient['submitMcpAuthCode']>[0]
        );
      case DaemonDroolMethod.SUBMIT_MCP_AUTH_ERROR:
        return this.runtime.submitMcpAuthError(
          params as Parameters<DaemonClient['submitMcpAuthError']>[0]
        );
      case DaemonDroolMethod.ARCHIVE_SESSION:
        return this.runtime.archiveSession(
          params as Parameters<DaemonClient['archiveSession']>[0]
        );
      case DaemonDroolMethod.UNARCHIVE_SESSION:
        return this.runtime.unarchiveSession(
          params as Parameters<DaemonClient['unarchiveSession']>[0]
        );
      case DaemonDroolMethod.RENAME_SESSION:
        return this.runtime.renameSession(
          params as Parameters<DaemonClient['renameSession']>[0],
          id
        );
      case DaemonDroolMethod.LIST_SKILLS:
        return this.runtime.listSkills(
          params as Parameters<DaemonClient['listSkills']>[0]
        );
      case DaemonDroolMethod.LIST_COMMANDS:
        return this.runtime.listCommands(
          params as Parameters<DaemonClient['listCommands']>[0]
        );
      case DaemonDroolMethod.GET_CONTEXT_BREAKDOWN:
        return this.runtime.getContextBreakdown(
          params as Parameters<DaemonClient['getContextBreakdown']>[0]
        );
      case DaemonDroolMethod.LIST_AVAILABLE_PLUGINS:
        return this.runtime.listAvailablePlugins(
          params as Parameters<DaemonClient['listAvailablePlugins']>[0]
        );
      case DaemonDroolMethod.LIST_INSTALLED_PLUGINS:
        return this.runtime.listInstalledPlugins(
          params as Parameters<DaemonClient['listInstalledPlugins']>[0]
        );
      case DaemonDroolMethod.INSTALL_PLUGIN:
        return this.runtime.installPlugin(
          params as Parameters<DaemonClient['installPlugin']>[0]
        );
      case DaemonDroolMethod.UNINSTALL_PLUGIN:
        return this.runtime.uninstallPlugin(
          params as Parameters<DaemonClient['uninstallPlugin']>[0]
        );
      case DaemonDroolMethod.SET_PLUGIN_ENABLED:
        return this.runtime.setPluginEnabled(
          params as Parameters<DaemonClient['setPluginEnabled']>[0]
        );
      case DaemonDroolMethod.UPDATE_PLUGIN:
        return this.runtime.updatePlugin(
          params as Parameters<DaemonClient['updatePlugin']>[0]
        );
      case DaemonDroolMethod.LIST_MARKETPLACES:
        return this.runtime.listMarketplaces(
          params as Parameters<DaemonClient['listMarketplaces']>[0]
        );
      case DaemonDroolMethod.ADD_MARKETPLACE:
        return this.runtime.addMarketplace(
          params as Parameters<DaemonClient['addMarketplace']>[0]
        );
      case DaemonDroolMethod.REMOVE_MARKETPLACE:
        return this.runtime.removeMarketplace(
          params as Parameters<DaemonClient['removeMarketplace']>[0]
        );
      case DaemonDroolMethod.UPDATE_MARKETPLACE:
        return this.runtime.updateMarketplace(
          params as Parameters<DaemonClient['updateMarketplace']>[0]
        );
      case DaemonDroolMethod.SUBMIT_BUG_REPORT:
        return this.runtime.submitBugReport(
          params as Parameters<DaemonClient['submitBugReport']>[0]
        );
      case DaemonDroolMethod.GET_REWIND_INFO:
        return this.runtime.getRewindInfo(
          params as Parameters<DaemonClient['getRewindInfo']>[0]
        );
      case DaemonDroolMethod.EXECUTE_REWIND:
        return this.runtime.executeRewind(
          params as Parameters<DaemonClient['executeRewind']>[0]
        );
      case DaemonDroolMethod.COMPACT_SESSION:
        return this.runtime.compactSession(
          params as Parameters<DaemonClient['compactSession']>[0]
        );
      case DaemonDroolMethod.FORK_SESSION:
        return this.runtime.forkSession(
          params as Parameters<DaemonClient['forkSession']>[0]
        );
      case DaemonDroolMethod.LIST_OPENED_SESSIONS:
        return this.runtime.listOpenedSessions(
          params as Parameters<DaemonClient['listOpenedSessions']>[0]
        );
      case DaemonDroolMethod.LIST_AVAILABLE_SESSIONS:
        return this.runtime.listAvailableSessions(
          params as Parameters<DaemonClient['listAvailableSessions']>[0]
        );
      case DaemonDroolMethod.GET_SESSION_MESSAGES:
        return this.runtime.getSessionMessages(
          params as Parameters<DaemonClient['getSessionMessages']>[0]
        );
      case DaemonDroolMethod.LIST_AUTOMATIONS:
        return this.runtime.listAutomations(
          params as Parameters<DaemonClient['listAutomations']>[0]
        );
      case DaemonDroolMethod.RUN_AUTOMATION:
        return this.runtime.runAutomation(
          params as Parameters<DaemonClient['runAutomation']>[0]
        );
      case DaemonDroolMethod.PAUSE_AUTOMATION:
        return this.runtime.pauseAutomation(
          params as Parameters<DaemonClient['pauseAutomation']>[0]
        );
      case DaemonDroolMethod.RESUME_AUTOMATION:
        return this.runtime.resumeAutomation(
          params as Parameters<DaemonClient['resumeAutomation']>[0]
        );
      case DaemonDroolMethod.GET_AUTOMATION_HISTORY:
        return this.runtime.getAutomationHistory(
          params as Parameters<DaemonClient['getAutomationHistory']>[0]
        );
      case DaemonDroolMethod.GET_AUTOMATION_VISUAL:
        return this.runtime.getAutomationVisual(
          params as Parameters<DaemonClient['getAutomationVisual']>[0]
        );
      case DaemonDroolMethod.CREATE_AUTOMATION:
        return this.runtime.createAutomation(
          params as Parameters<DaemonClient['createAutomation']>[0]
        );
      case DaemonDroolMethod.UPDATE_AUTOMATION_MODEL:
        return this.runtime.updateAutomationModel(
          params as Parameters<DaemonClient['updateAutomationModel']>[0]
        );
      case DaemonDroolMethod.UPDATE_AUTOMATION_PRIVACY:
        return this.runtime.updateAutomationPrivacy(
          params as Parameters<DaemonClient['updateAutomationPrivacy']>[0]
        );
      case DaemonDroolMethod.RENAME_AUTOMATION:
        return this.runtime.renameAutomation(
          params as Parameters<DaemonClient['renameAutomation']>[0]
        );
      case DaemonDroolMethod.DELETE_AUTOMATION:
        return this.runtime.deleteAutomation(
          params as Parameters<DaemonClient['deleteAutomation']>[0]
        );
      case DaemonDroolMethod.FORK_AUTOMATION:
        return this.runtime.forkAutomation(
          params as Parameters<DaemonClient['forkAutomation']>[0]
        );
      case DaemonDroolMethod.GET_GIT_DIFF:
        return this.runtime.getGitDiff(
          params as Parameters<DaemonClient['getGitDiff']>[0]
        );
      case DaemonDroolMethod.INSPECT_MISSION_READINESS:
        return this.runtime.inspectMissionReadiness(
          params as Parameters<DaemonClient['inspectMissionReadiness']>[0]
        );
      case DaemonDroolMethod.GIT_PUSH:
        return this.runtime.gitPush(
          params as Parameters<DaemonClient['gitPush']>[0]
        );
      case DaemonDroolMethod.GIT_COMMIT:
        return this.runtime.gitCommit(
          params as Parameters<DaemonClient['gitCommit']>[0]
        );
      case DaemonDroolMethod.CREATE_PR:
        return this.runtime.createPR(
          params as Parameters<DaemonClient['createPR']>[0]
        );
      case DaemonDroolMethod.GET_SEMANTIC_DIFF_CACHE:
        return this.runtime.getSemanticDiffCache(
          params as Parameters<DaemonClient['getSemanticDiffCache']>[0]
        );
      case DaemonDroolMethod.SAVE_SEMANTIC_DIFF_CACHE:
        return this.runtime.saveSemanticDiffCache(
          params as Parameters<DaemonClient['saveSemanticDiffCache']>[0]
        );
      case DaemonDroolMethod.GENERATE_SEMANTIC_DIFF:
        return this.runtime.generateSemanticDiff(
          params as Parameters<DaemonClient['generateSemanticDiff']>[0]
        );
      case DaemonDroolMethod.GET_PROXY_TOKEN:
        return this.runtime.getProxyToken();
      case DaemonDroolMethod.GET_WORKSPACE_FILE_CONTENT:
        return this.runtime.getWorkspaceFileContent(
          params as Parameters<DaemonClient['getWorkspaceFileContent']>[0]
        );
      default:
        throw new InProcessDaemonMethodNotFoundError(method);
    }
  }
}
