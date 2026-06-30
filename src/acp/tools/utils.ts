import type { ToolKind } from '@agentclientprotocol/sdk';

const TOOL_KIND_KEYWORDS: Array<{ kind: ToolKind; keywords: string[] }> = [
  {
    kind: 'edit',
    keywords: ['edit', 'apply_patch', 'write', 'create', 'todo'],
  },
  { kind: 'execute', keywords: ['bash', 'exec', 'shell', 'command', 'run'] },
  { kind: 'read', keywords: ['read', 'list', 'ls', 'cat'] },
  { kind: 'search', keywords: ['rg', 'search', 'grep', 'find'] },
  { kind: 'think', keywords: ['plan', 'analyze', 'reason'] },
];

export function inferToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();
  for (const entry of TOOL_KIND_KEYWORDS) {
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) {
      return entry.kind;
    }
  }
  return 'other';
}
