import type { TodoItem } from './schema';

/**
 * Parses a string format todo list into TodoItem array.
 * Supports formats like:
 * - "1. [pending] Task description"
 * - "1) [completed] Task description"
 * - "[in_progress] Task description"
 * - "- [pending] Task description" (bullet + bracket-status)
 * - "1. Task description" (auto-assigns pending)
 * - "- [x] Task" / "- [ ] Task" (markdown checkboxes)
 * - "1. [x] Task" / "1) [ ] Task" (numbered checkboxes)
 * - "- Task description" / "* Task description" (bullets)
 * - Plain text lines (auto-assigns pending)
 */
export function parseStringFormat(str: string): TodoItem[] {
  const lines = str
    .trim()
    .split('\n')
    .filter((line) => line.trim());

  if (lines.length === 0) {
    return [];
  }

  return lines.map((line, index) => {
    const trimmed = line.trim();

    // Standard format: "1. [status] content", "[status] content", "1) [status] content",
    // or "- [status] content", "* [status] content" (bullet + bracket-status)
    const standardMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[(completed|in_progress|pending)\]\s*(.*)$/
    );
    if (standardMatch) {
      return {
        id: String(index + 1),
        status: standardMatch[1] as 'completed' | 'in_progress' | 'pending',
        content: standardMatch[2].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Markdown checkbox (checked): "- [x] content", "* [X] content", "1. [x] content", "1) [x] content"
    const checkedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[[xX]\]\s*(.*)$/
    );
    if (checkedMatch) {
      return {
        id: String(index + 1),
        status: 'completed' as const,
        content: checkedMatch[1].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Markdown checkbox (unchecked): "- [ ] content", "* [ ] content", "1. [ ] content", "1) [ ] content"
    const uncheckedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[\s*\]\s*(.*)$/
    );
    if (uncheckedMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: uncheckedMatch[1].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Numbered without status: "1. content" or "1) content"
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: numberedMatch[1].trim(),
        priority: 'high' as const,
      };
    }

    // Bullet without status: "- content" or "* content"
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: bulletMatch[1].trim(),
        priority: 'high' as const,
      };
    }

    // Plain text fallback: treat as pending
    return {
      id: String(index + 1),
      status: 'pending' as const,
      content: trimmed,
      priority: 'high' as const,
    };
  });
}

/**
 * Type guard to validate if an unknown value is a valid TodoItem.
 */
export function isValidTodoItem(item: unknown): item is TodoItem {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.content === 'string' &&
    typeof obj.status === 'string' &&
    ['pending', 'in_progress', 'completed'].includes(obj.status)
  );
}
