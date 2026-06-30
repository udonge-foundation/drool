export enum MessageVisibility {
  Both = 'both',
  LLMOnly = 'llm_only',
  UserOnly = 'user_only',
}

export enum MessageRoleNoSystem {
  User = 'user',
  Assistant = 'assistant',
  Tool = 'tool',
}

export enum MessageRole {
  User = 'user',
  Assistant = 'assistant',
  Tool = 'tool',
  System = 'system',
}

export enum MessageContentBlockType {
  Text = 'text',
  Image = 'image',
  Thinking = 'thinking',
  RedactedThinking = 'redacted_thinking',
  ToolUse = 'tool_use',
  ToolResult = 'tool_result',
  Document = 'document',
}

export enum DocumentSourceType {
  Base64 = 'base64',
  Text = 'text',
}
