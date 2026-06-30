import fs from 'fs/promises';
import path from 'path';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { type Skill } from '@industry/common/settings';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { getFlag } from '@industry/runtime/feature-flags';
import { SettingsManager } from '@industry/runtime/settings';
import { loadSkillFile } from '@industry/utils/frontmatter';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getDecompSessionTypeFromTags } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { isSquadSession } from '@/services/squad/sessionTags';
import { AGENT_BROWSER_BASE_PROMPT } from '@/skills/builtin/agent-browser/prompt';
import {
  BUILTIN_DEEP_SECURITY_REVIEW_SKILL,
  BUILTIN_EXCEL_SKILL,
  BUILTIN_INCIDENT_SKILL,
  BUILTIN_INIT_SKILL,
  BUILTIN_INSTALL_CODE_REVIEW_SKILL,
  BUILTIN_INSTALL_QA_SKILL,
  BUILTIN_INSTALL_TRIAGE_SKILL,
  BUILTIN_INSTALL_WIKI_SKILL,
  BUILTIN_PDF_DOCUMENT_SKILL,
  BUILTIN_POWERPOINT_SKILL,
  BUILTIN_REVIEW_SKILL,
  BUILTIN_SECURITY_REVIEW_SKILL,
  BUILTIN_SIMPLIFY_SKILL,
  BUILTIN_SESSION_NAVIGATION_SKILL,
  BUILTIN_WORD_DOCUMENT_SKILL,
  BUILTIN_BROWSE_WIKI_SKILL,
  BUILTIN_WIKI_SKILL,
  BUILTIN_WIKI_VIDEO_GEN_SKILL,
} from '@/skills/builtin/builtinSkillDefinitions';
import {
  AGENT_BROWSER_SKILL_DESKTOP_CDP_SECTION,
  BUILTIN_FIGMA_MCP_HELPER_SKILL,
  BUILTIN_ORCHESTRATOR_SKILLS,
  BUILTIN_TUISTORY_SKILL,
  BUILTIN_WORKER_SKILLS,
} from '@/skills/builtin/constants';
import {
  BUILTIN_SQUAD_ORCHESTRATOR_SKILLS,
  BUILTIN_SQUAD_WORKER_SKILLS,
} from '@/skills/builtin/squad/constants';
import type { GetAllSkillsOptions } from '@/skills/builtin/types';
import { DynamicContextDiscovery } from '@/utils/dynamicContextDiscovery';
import { sanitizeSkillName } from '@/utils/skills/paths';

const SKILL_PROMPT_FILE = 'SKILL.md';

function isSafeMissionId(missionId: string): boolean {
  const trimmed = missionId.trim();
  if (trimmed.length === 0 || trimmed !== missionId) {
    return false;
  }

  if (path.isAbsolute(trimmed)) {
    return false;
  }

  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    return false;
  }

  return trimmed === path.basename(trimmed);
}

async function findMissionSkillDirectories(
  skillsDir: string
): Promise<string[]> {
  async function search(dir: string, visited: Set<string>): Promise<string[]> {
    let realPath: string;
    try {
      realPath = await fs.realpath(dir);
    } catch {
      return [];
    }
    if (visited.has(realPath)) return [];
    visited.add(realPath);

    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
    }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map(async (entry) => {
          const entryPath = path.join(dir, entry.name);
          try {
            await fs.access(path.join(entryPath, SKILL_PROMPT_FILE));
            return [entryPath];
          } catch {
            return search(entryPath, visited);
          }
        })
    );

    return results.flat();
  }

  return search(skillsDir, new Set());
}

async function loadMissionSkills(missionId?: string): Promise<Skill[]> {
  if (!missionId || !isSafeMissionId(missionId)) {
    return [];
  }

  const skillsDir = path.join(
    getMissionFileService(missionId).getMissionDir(),
    'skills'
  );
  const skillDirPaths = await findMissionSkillDirectories(skillsDir);
  const loaded = await Promise.all(
    skillDirPaths.map((skillDirPath) =>
      loadSkillFile(
        path.join(skillDirPath, SKILL_PROMPT_FILE),
        SkillLocation.Project
      )
    )
  );

  return loaded.filter((skill): skill is Skill => skill !== null);
}

function getBuiltinAgentBrowserSkill(): Skill {
  const hasDesktopCdp = Boolean(
    process.env.INDUSTRY_DESKTOP_CDP_PORT && process.env.AGENT_BROWSER_CDP
  );
  const systemPrompt = hasDesktopCdp
    ? AGENT_BROWSER_BASE_PROMPT.replace(
        '# agent-browser core',
        `# agent-browser core\n${AGENT_BROWSER_SKILL_DESKTOP_CDP_SECTION}`
      )
    : AGENT_BROWSER_BASE_PROMPT;

  return {
    metadata: {
      name: 'agent-browser',
      description:
        'Automates browsers and Electron desktop apps (VS Code, Slack, Discord, Figma, Notion, Spotify, etc.) for testing, form filling, screenshots, and data extraction. Use when the user needs to navigate, interact with, test, or extract data from any website or Electron desktop app.',
    },
    systemPrompt,
    location: SkillLocation.Builtin,
    filePath: 'builtin:agent-browser',
    lastModified: 0,
    validationResult: { valid: true, errors: [], warnings: [] },
  };
}

/**
 * Get built-in skills filtered by session type and feature flags.
 * - Orchestrator sessions get orchestrator skills
 * - Worker sessions get worker skills
 * - Standard sessions get agent-browser skill only
 * - Wiki-gated skills are included only when the Wiki feature flag is enabled
 */
function getBuiltinSkills(
  decompSessionType?: DecompSessionType,
  isWikiEnabled = false,
  isIncidentResponseEnabled = false
): Skill[] {
  const isSquad = isSquadSession(getSessionService().getCurrentSessionTags());

  const featureFlaggedSkills: Skill[] = [
    BUILTIN_INSTALL_QA_SKILL,
    BUILTIN_SECURITY_REVIEW_SKILL,
    BUILTIN_DEEP_SECURITY_REVIEW_SKILL,
  ];
  if (isWikiEnabled) {
    featureFlaggedSkills.push(BUILTIN_WIKI_SKILL);
    featureFlaggedSkills.push(BUILTIN_WIKI_VIDEO_GEN_SKILL);
    featureFlaggedSkills.push(BUILTIN_INSTALL_WIKI_SKILL);
    featureFlaggedSkills.push(BUILTIN_BROWSE_WIKI_SKILL);
  }
  if (isIncidentResponseEnabled) {
    featureFlaggedSkills.push(BUILTIN_INCIDENT_SKILL);
  }

  if (decompSessionType === DecompSessionType.Orchestrator) {
    return [
      ...(isSquad
        ? BUILTIN_SQUAD_ORCHESTRATOR_SKILLS
        : BUILTIN_ORCHESTRATOR_SKILLS),
      getBuiltinAgentBrowserSkill(),
      BUILTIN_TUISTORY_SKILL,
      BUILTIN_FIGMA_MCP_HELPER_SKILL,
      ...featureFlaggedSkills,
    ];
  }
  if (decompSessionType === DecompSessionType.Worker) {
    return [
      ...(isSquad ? BUILTIN_SQUAD_WORKER_SKILLS : BUILTIN_WORKER_SKILLS),
      getBuiltinAgentBrowserSkill(),
      BUILTIN_TUISTORY_SKILL,
      BUILTIN_FIGMA_MCP_HELPER_SKILL,
      ...featureFlaggedSkills,
    ];
  }
  return [
    getBuiltinAgentBrowserSkill(),
    BUILTIN_TUISTORY_SKILL,
    BUILTIN_FIGMA_MCP_HELPER_SKILL,
    BUILTIN_INIT_SKILL,
    BUILTIN_INSTALL_CODE_REVIEW_SKILL,
    BUILTIN_INSTALL_TRIAGE_SKILL,
    BUILTIN_REVIEW_SKILL,
    BUILTIN_SIMPLIFY_SKILL,
    BUILTIN_SESSION_NAVIGATION_SKILL,
    BUILTIN_PDF_DOCUMENT_SKILL,
    BUILTIN_POWERPOINT_SKILL,
    BUILTIN_EXCEL_SKILL,
    BUILTIN_WORD_DOCUMENT_SKILL,
    ...featureFlaggedSkills,
  ];
}

function mergeUniqueSkills(skillGroups: Skill[][]): Skill[] {
  const merged: Skill[] = [];
  const seenNames = new Set<string>();

  for (const skills of skillGroups) {
    for (const skill of skills) {
      const normalizedName = sanitizeSkillName(skill.metadata.name);
      if (seenNames.has(normalizedName)) {
        continue;
      }
      seenNames.add(normalizedName);
      merged.push(skill);
    }
  }

  return merged;
}

/**
 * Get all skills (builtin + filesystem + dynamically discovered) merged together.
 * Builtin skills are filtered based on the current decomposition session type.
 * Dynamically discovered skills (from Read tool path traversal) are included
 * via a side registry to avoid changing the Skill tool description and
 * invalidating prompt caches.
 */
export async function getAllSkills(
  options: GetAllSkillsOptions = {}
): Promise<Skill[]> {
  const { validOnly = false, excludeDynamic = false } = options;

  const settings = await SettingsManager.getInstance().getResolvedSettings();
  const sessionService = getSessionService();
  const tags = sessionService.getCurrentSessionTags();
  const decompSessionType = getDecompSessionTypeFromTags(tags);

  const isWikiEnabled = getFlag(IndustryFeatureFlags.Wiki);
  const isIncidentResponseEnabled = getFlag(
    IndustryFeatureFlags.IncidentResponse
  );
  const builtinSkills = getBuiltinSkills(
    decompSessionType,
    isWikiEnabled,
    isIncidentResponseEnabled
  );
  let missionSkills = await loadMissionSkills(
    sessionService.getDecompMissionId()
  );
  if (validOnly) {
    missionSkills = missionSkills.filter(
      (s) => s.validationResult.valid && s.metadata.enabled !== false
    );
  }

  let filesystemSkills = settings.skills ?? [];
  if (validOnly) {
    filesystemSkills = filesystemSkills.filter(
      (s) => s.validationResult.valid && s.metadata.enabled !== false
    );
  }

  if (excludeDynamic) {
    return mergeUniqueSkills([builtinSkills, missionSkills, filesystemSkills]);
  }

  // Include dynamically discovered skills from the side registry.
  // These are NOT reflected in the Skill tool description to preserve
  // prompt caching — the model learns about them via system reminders
  // appended to Read tool results.
  let dynamicSkills = DynamicContextDiscovery.getInstance().getDynamicSkills();
  if (validOnly) {
    dynamicSkills = dynamicSkills.filter(
      (s) => s.validationResult.valid && s.metadata.enabled !== false
    );
  }

  return mergeUniqueSkills([
    builtinSkills,
    missionSkills,
    filesystemSkills,
    dynamicSkills,
  ]);
}
