import { z } from 'zod';

import { SkillFrontmatterSchema } from '@industry/common/settings';
import { logWarn } from '@industry/logging';

import { parseFrontmatter } from './frontmatter';

/**
 * Parse skill frontmatter with schema validation.
 */
export function parseSkillFrontmatter(content: string): {
  frontmatter: z.infer<typeof SkillFrontmatterSchema>;
  systemPrompt: string;
} {
  const { metadata, body } = parseFrontmatter(content);

  const validated = SkillFrontmatterSchema.safeParse(metadata);
  if (validated.success) {
    return { frontmatter: validated.data, systemPrompt: body.trim() };
  }

  const skillName =
    typeof metadata.name === 'string' ? metadata.name : 'unknown';
  logWarn('Invalid skill frontmatter schema', {
    name: skillName,
    error: validated.error.message,
  });
  // Return partial frontmatter with defaults applied manually for error case
  return {
    frontmatter: {
      name: skillName,
      description: '',
      enabled: false,
      'user-invocable': true,
      'disable-model-invocation': false,
    },
    systemPrompt: body.trim(),
  };
}
