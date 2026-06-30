const MARKDOWN_PATTERNS = [
  /```[\s\S]*?```/, // Code blocks
  /`[^`]*`/, // Inline code
  /^#{1,6}\s/m, // Headers
  /^\* /m, // Bullet lists
  /^\d+\. /m, // Numbered lists
  /\*\*[^*]+\*\*/, // Bold text
  /\*[^*]+\*/, // Italic text
];

export function isMarkdownContent(content: string): boolean {
  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(content));
}
