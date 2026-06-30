import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { loadSkillFromContent } from '@industry/utils/frontmatter';

import type { Skill } from '@industry/common/settings';

export function loadBuiltinSkill(rawContent: string): Skill {
  const skill = loadSkillFromContent(rawContent, SkillLocation.Builtin, '', 0);
  skill.filePath = `builtin:${skill.metadata.name}`;
  return skill;
}
