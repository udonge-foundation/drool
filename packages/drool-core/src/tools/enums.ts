export enum DraftToolFeedbackType {
  Update = 'update',
  Result = 'result',
}
export enum Toolkit {
  Base = 'Base', // Base toolkit for tools that should always be available and not shown to the user
  WebSearch = 'Web Search',
  CodeSearch = 'Code Search',
  Terminal = 'Terminal',
  Slack = 'Slack',
  Connectors = 'Connectors',
}

export enum SandboxSideEffect {
  FilesystemRead = 'filesystem-read',
  FilesystemWrite = 'filesystem-write',
  Network = 'network',
  Process = 'process',
  ExternalService = 'external-service',
  PersistentSettings = 'persistent-settings',
}

export enum ToolUIGroupId {
  // File Tools
  ViewFile = 'view_file',
  EditFile = 'edit_file',
  CreateFile = 'create_file',
  ViewFolder = 'view_folder',

  // Search & Navigation Tools
  GlobTool = 'glob_tool',
  GrepTool = 'grep_tool',

  // Planning Tools
  Planning = 'planning',

  // Terminal & Execution Tools
  ExecuteTerminalCommand = 'execute_terminal_command',

  // Slack Integration Tools
  SlackPostFile = 'slack_post_file',
  SlackPostMessage = 'slack_post_message',

  // Connectors (Merge Agent Handler) Tools
  ConnectorSearch = 'connector_search',

  // Web & External Tools
  WebSearch = 'web_search',
  FetchUrl = 'fetch_url',
}

export enum ComplexityTier {
  Light = 'light',
  Medium = 'medium',
  Heavy = 'heavy',
}

export enum GrepTool {
  RIPGREP = 'rg',
  GREP = 'grep',
  FINDSTR = 'findstr',
}
