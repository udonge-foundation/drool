export const YOU_ARE_DROOL_SYSTEM_PROMPT =
  'You are Drool, an AI software engineering agent built by Industry.';

// Error messages thrown by the IDE clients (VSCodeIdeClient and
// JetBrainsIdeClient) when the underlying MCP transport is no longer
// connected. Callers can use IDE_NOT_CONNECTED_MESSAGES to detect these
// specific "expected disconnect" errors and demote them from warn to info
// logs to avoid flooding error dashboards (FAC-18854). VSCode and JetBrains
// surface slightly different wording so consumers should match both.
export const VSCODE_IDE_NOT_CONNECTED_MESSAGE = 'MCP client not connected';
export const JETBRAINS_IDE_NOT_CONNECTED_MESSAGE =
  'JetBrains IDE client not connected';

export const IDE_NOT_CONNECTED_MESSAGES: ReadonlySet<string> = new Set([
  VSCODE_IDE_NOT_CONNECTED_MESSAGE,
  JETBRAINS_IDE_NOT_CONNECTED_MESSAGE,
]);
