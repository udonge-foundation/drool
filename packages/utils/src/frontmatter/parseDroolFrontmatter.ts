import { DroolFrontmatterSchema } from '@industry/common/settings';
import { logWarn } from '@industry/logging';

import { parseFrontmatter } from './frontmatter';

/**
 * Parse drool frontmatter with schema validation.
 */
export function parseDroolFrontmatter(content: string): {
  frontmatter: ReturnType<typeof DroolFrontmatterSchema.parse>;
  systemPrompt: string;
} {
  const { metadata, body } = parseFrontmatter(content);

  const validated = DroolFrontmatterSchema.safeParse(metadata);
  if (validated.success) {
    return { frontmatter: validated.data, systemPrompt: body.trim() };
  }

  logWarn('Invalid drool frontmatter schema', {
    error: validated.error.message,
  });
  return { frontmatter: {}, systemPrompt: body.trim() };
}
