/* eslint-disable import/order */
import type { PromptRequest, ToolCallContent } from '@agentclientprotocol/sdk';
import { type Base64ImageSource } from '@industry/drool-sdk-ext/protocol/sessionV2';
import type {
  TodoItem,
  TodoWriteToolInput,
} from '@industry/drool-core/tools/definitions/todo';
import { logWarn } from '@industry/logging';
import { parseTodosInput } from '@/utils/todo-utils';
/* eslint-enable import/order */

function formatResourceLink(uri: string): string {
  try {
    if (uri.startsWith('file://')) {
      const name = uri.split('/').pop();
      return name ? `[@${name}](${uri})` : uri;
    }
    if (uri.startsWith('zed://')) {
      const [, name] = /zed:\/\/[^/]+\/(.+)$/.exec(uri) ?? [];
      return name ? `[@${name}](${uri})` : uri;
    }
  } catch (error) {
    logWarn('Failed to format ACP resource link', {
      error: error instanceof Error ? error.message : String(error),
      url: uri,
    });
  }
  return uri;
}

export function formatPromptForExec(prompt: PromptRequest): string {
  const primary: string[] = [];
  const contextual: string[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case 'text':
        primary.push(chunk.text);
        break;
      case 'resource_link':
        primary.push(formatResourceLink(chunk.uri));
        break;
      case 'resource': {
        if ('text' in chunk.resource && chunk.resource.text) {
          const link = formatResourceLink(chunk.resource.uri);
          primary.push(link);
          contextual.push(
            `<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`
          );
        }
        break;
      }
      default:
        break;
    }
  }

  if (contextual.length > 0) {
    primary.push(contextual.join('\n'));
  }

  return primary.join('\n').trim();
}

const VALID_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function extractImagesFromPrompt(
  prompt: PromptRequest
): Base64ImageSource[] {
  const images: Base64ImageSource[] = [];

  for (const chunk of prompt.prompt) {
    if (chunk.type === 'image' && chunk.data && chunk.mimeType) {
      // Validate mime type matches what Base64ImageSource expects
      if (VALID_IMAGE_MIME_TYPES.has(chunk.mimeType)) {
        images.push({
          type: 'base64',
          data: chunk.data,
          mediaType: chunk.mimeType as Base64ImageSource['mediaType'],
        });
      } else {
        logWarn('[ACP] Skipping image with unsupported mime type', {
          mimeType: chunk.mimeType,
        });
      }
    }
  }

  return images;
}

function buildFilePathContentBlock(
  input: Record<string, unknown>
): ToolCallContent {
  const filePath = (input as { file_path?: string }).file_path ?? 'unknown';
  return {
    type: 'content',
    content: {
      type: 'text',
      text: filePath,
    },
  };
}

function buildDirectoryContentBlock(
  input: Record<string, unknown>
): ToolCallContent {
  const dirPath =
    (input as { directory_path?: string }).directory_path ??
    (input as { path?: string }).path ??
    'current directory';
  return {
    type: 'content',
    content: {
      type: 'text',
      text: dirPath === '.' ? 'current directory' : dirPath,
    },
  };
}

function buildPatternContentBlock(
  input: Record<string, unknown>
): ToolCallContent {
  const pattern = (input as { pattern?: string }).pattern ?? '';
  const path = (input as { path?: string }).path;
  const text = path ? `${pattern} in ${path}` : pattern;
  return {
    type: 'content',
    content: {
      type: 'text',
      text,
    },
  };
}

export function parseTodoParams(
  input: Record<string, unknown>
): TodoItem[] | undefined {
  if (!input || !('todos' in input)) {
    return undefined;
  }

  const todosRaw = (input as { todos?: TodoWriteToolInput['todos'] }).todos;
  if (todosRaw === undefined) {
    return undefined;
  }

  const todos = parseTodosInput({ todos: todosRaw });

  return todos.length > 0 ? todos : undefined;
}

export function mapTodoPriority(priority: unknown): 'low' | 'medium' | 'high' {
  if (typeof priority !== 'string') return 'medium';
  const p = priority.toLowerCase();
  if (p === 'low' || p === 'high') return p as 'low' | 'high';
  return 'medium';
}

export function mapTodoStatus(
  status: unknown
): 'pending' | 'in_progress' | 'completed' {
  if (typeof status !== 'string') return 'pending';
  const s = status.toLowerCase();
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  return 'pending';
}

export function buildToolInputContent(
  name: string,
  input: Record<string, unknown>
): ToolCallContent[] | undefined {
  if (!input || Object.keys(input).length === 0) {
    return undefined;
  }

  if (name === 'ExitSpecMode') {
    const plan = (input as { plan?: string }).plan;
    if (plan) {
      return [
        {
          type: 'content',
          content: {
            type: 'text',
            text: plan,
          },
        },
      ];
    }
    return undefined;
  }

  if (name === 'TodoWrite') {
    const todos = parseTodoParams(input);
    if (todos?.length) {
      // Show a summary of todo items
      const summary = todos
        .map(
          (todo) => `${todo.status === 'completed' ? '✓' : '○'} ${todo.content}`
        )
        .join('\n');
      return [
        {
          type: 'content',
          content: {
            type: 'text',
            text: summary,
          },
        },
      ];
    }
    return undefined;
  }

  if (name === 'Read') {
    return [buildFilePathContentBlock(input)];
  }

  if (name === 'Create') {
    // Show diff for new file
    const filePath = (input as { file_path?: string }).file_path;
    const content = (input as { content?: string }).content;

    if (filePath && content) {
      return [
        {
          type: 'diff',
          path: filePath,
          oldText: null, // null indicates new file
          newText: content,
        },
      ];
    }
    return undefined;
  }

  if (name === 'Edit') {
    // Show diff for edited file
    const filePath = (input as { file_path?: string }).file_path;
    const oldStr = (input as { old_str?: string }).old_str;
    const newStr = (input as { new_str?: string }).new_str;

    if (filePath && oldStr !== undefined && newStr !== undefined) {
      return [
        {
          type: 'diff',
          path: filePath,
          oldText: oldStr, // Show the replaced text
          newText: newStr, // Show the new text
        },
      ];
    }
    return undefined;
  }

  if (name === 'LS') {
    return [buildDirectoryContentBlock(input)];
  }

  if (name === 'Grep') {
    return [buildPatternContentBlock(input)];
  }

  if (name === 'Execute') {
    // Show command description if provided, otherwise show nothing
    // (the command itself will be in the title)
    if ('description' in input && input.description) {
      return [
        {
          type: 'content',
          content: {
            type: 'text',
            text: String(input.description),
          },
        },
      ];
    }
    return undefined; // Don't show raw input JSON
  }

  // For unhandled tools, don't show raw JSON - let the title be descriptive
  return undefined;
}

export function buildToolResultContent(
  name: string | undefined,
  text?: string
): ToolCallContent[] | undefined {
  if (!text) {
    return undefined;
  }

  // Suppress output for successful Create/Edit operations
  // The diff is already shown in the tool call content
  if (name === 'Create' || name === 'Edit') {
    return undefined;
  }

  if (name === 'TodoWrite') {
    return [
      {
        type: 'content',
        content: {
          type: 'text',
          text,
        },
      },
    ];
  }

  return [
    {
      type: 'content',
      content: {
        type: 'text',
        text,
      },
    },
  ];
}

export function generateToolTitle(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === 'ExitSpecMode') {
    return 'Approve Spec';
  }

  let title = toolName;
  if (toolName === 'Read' && input && 'file_path' in input) {
    const filePath = (input as { file_path?: string }).file_path ?? '';
    title = `Read ${filePath}`;
  } else if (toolName === 'LS') {
    // Check both directory_path (actual param name) and path (fallback)
    const dirPath =
      (input as { directory_path?: string }).directory_path ??
      (input as { path?: string }).path;
    if (dirPath && dirPath !== '.') {
      title = `List ${dirPath}`;
    } else {
      title = 'List directory';
    }
  } else if (toolName === 'Grep' && input && 'pattern' in input) {
    const pattern = (input as { pattern?: string }).pattern ?? '';
    const path = (input as { path?: string }).path;
    if (path) {
      title = `Grep ${pattern} in ${path}`;
    } else {
      title = `Grep ${pattern}`;
    }
  } else if (toolName === 'Glob' && input) {
    const raw = (input as { patterns?: string | string[] }).patterns;
    const patterns = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : typeof raw === 'string' && raw.length > 0
        ? [raw]
        : [];
    if (patterns.length > 0) {
      title = `Glob ${patterns.join(', ')}`;
    } else {
      title = 'Glob';
    }
  } else if (toolName === 'Execute' && input && 'command' in input) {
    // Show command in backticks with risk level
    const command = String(input.command);
    const escaped = command.replaceAll('`', '\\`');
    const riskLevel = (input as { riskLevel?: string }).riskLevel;
    if (riskLevel) {
      title = `\`${escaped}\` (${String(riskLevel).toLowerCase()})`;
    } else {
      title = `\`${escaped}\``;
    }
  } else if (toolName === 'Create' && input && 'file_path' in input) {
    const filePath = (input as { file_path?: string }).file_path ?? '';
    title = `Create ${filePath}`;
  } else if (toolName === 'Edit' && input && 'file_path' in input) {
    const filePath = (input as { file_path?: string }).file_path ?? '';
    title = `Edit \`${filePath}\``;
  }
  return title.trim() || toolName;
}

export function buildToolLocations(
  name: string,
  input: Record<string, unknown>
): Array<{ path: string; line?: number }> | undefined {
  if (name === 'Create' || name === 'Edit') {
    const filePath = (input as { file_path?: string }).file_path;
    if (filePath) {
      return [{ path: filePath }];
    }
  }

  if (name === 'Read') {
    const filePath = (input as { file_path?: string }).file_path;
    const offset = (input as { offset?: number }).offset;
    if (filePath) {
      return [{ path: filePath, line: offset ?? 0 }];
    }
  }

  return undefined;
}
