import browseWikiSkillContent from '../../../builtin-skills/browse-wiki/SKILL.md' with { type: 'text' };
import deepSecurityReviewContent from '../../../builtin-skills/deep-security-review/SKILL.md' with { type: 'text' };
import excelContent from '../../../builtin-skills/excel/SKILL.md' with { type: 'text' };
import incidentContent from '../../../builtin-skills/incident/SKILL.md' with { type: 'text' };
import initSkillContent from '../../../builtin-skills/init/SKILL.md' with { type: 'text' };
import installCodeReviewContent from '../../../builtin-skills/install-code-review/SKILL.md' with { type: 'text' };
import installQaContent from '../../../builtin-skills/install-qa/SKILL.md' with { type: 'text' };
import runTriagePy from '../../../builtin-skills/install-triage/assets/run_triage.py' with { type: 'text' };
import installTriageTemplate from '../../../builtin-skills/install-triage/SKILL.md' with { type: 'text' };
import installWikiContent from '../../../builtin-skills/install-wiki/SKILL.md' with { type: 'text' };
import pdfDocumentContent from '../../../builtin-skills/pdf-document/SKILL.md' with { type: 'text' };
import powerpointContent from '../../../builtin-skills/powerpoint/SKILL.md' with { type: 'text' };
import reviewSkillContent from '../../../builtin-skills/review/SKILL.md' with { type: 'text' };
import securityReviewContent from '../../../builtin-skills/security-review/SKILL.md' with { type: 'text' };
import sessionNavigationContent from '../../../builtin-skills/session-navigation/SKILL.md' with { type: 'text' };
import simplifySkillContent from '../../../builtin-skills/simplify/SKILL.md' with { type: 'text' };
import wikiContent from '../../../builtin-skills/wiki/SKILL.md' with { type: 'text' };
import wikiVideoGenContent from '../../../builtin-skills/wiki-video-gen/SKILL.md' with { type: 'text' };
import wordDocumentContent from '../../../builtin-skills/word-document/SKILL.md' with { type: 'text' };
import { loadBuiltinSkill } from '@/skills/builtin/loadBuiltinSkill';

import type { Skill } from '@industry/common/settings';

export const BUILTIN_INIT_SKILL: Skill = loadBuiltinSkill(initSkillContent);
export const BUILTIN_REVIEW_SKILL: Skill = loadBuiltinSkill(reviewSkillContent);
export const BUILTIN_SESSION_NAVIGATION_SKILL: Skill = loadBuiltinSkill(
  sessionNavigationContent
);

export const BUILTIN_INSTALL_WIKI_SKILL: Skill =
  loadBuiltinSkill(installWikiContent);

export const BUILTIN_WIKI_SKILL: Skill = loadBuiltinSkill(wikiContent);

export const BUILTIN_WIKI_VIDEO_GEN_SKILL: Skill =
  loadBuiltinSkill(wikiVideoGenContent);

export const BUILTIN_INCIDENT_SKILL: Skill = loadBuiltinSkill(incidentContent);

export const BUILTIN_INSTALL_CODE_REVIEW_SKILL: Skill = loadBuiltinSkill(
  installCodeReviewContent
);

export const BUILTIN_INSTALL_QA_SKILL: Skill =
  loadBuiltinSkill(installQaContent);

const installTriageContent = installTriageTemplate.replace(
  '{{RUN_TRIAGE_PY}}',
  runTriagePy.trimEnd()
);

export const BUILTIN_INSTALL_TRIAGE_SKILL: Skill =
  loadBuiltinSkill(installTriageContent);

export const BUILTIN_SECURITY_REVIEW_SKILL: Skill = loadBuiltinSkill(
  securityReviewContent
);

export const BUILTIN_DEEP_SECURITY_REVIEW_SKILL: Skill = loadBuiltinSkill(
  deepSecurityReviewContent
);

export const BUILTIN_SIMPLIFY_SKILL: Skill =
  loadBuiltinSkill(simplifySkillContent);

export const BUILTIN_BROWSE_WIKI_SKILL: Skill = loadBuiltinSkill(
  browseWikiSkillContent
);

export const BUILTIN_PDF_DOCUMENT_SKILL: Skill =
  loadBuiltinSkill(pdfDocumentContent);

export const BUILTIN_POWERPOINT_SKILL: Skill =
  loadBuiltinSkill(powerpointContent);

export const BUILTIN_EXCEL_SKILL: Skill = loadBuiltinSkill(excelContent);

export const BUILTIN_WORD_DOCUMENT_SKILL: Skill =
  loadBuiltinSkill(wordDocumentContent);
