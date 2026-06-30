import fs from 'fs/promises';
import path from 'path';

import { SkillFrontmatterSchema } from '@industry/common/settings';
import { parseFrontmatter } from '@industry/utils/frontmatter';

import type { Feature } from '@/services/mission/types';
import { VALIDATION_SKILL_NAMES } from '@/skills/builtin/constants';
import { sanitizeSkillName } from '@/utils/skills/paths';

const SKILL_PROMPT_FILE = 'SKILL.md';

// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type MissionScopedFeatureSkillsValidationResult =
  | { ok: true }
  | { ok: false; userError: string; llmError: string };

interface ReferencedSkill {
  requestedName: string;
  normalizedName: string;
  featureIds: string[];
}

type LoadedMissionSkill =
  | {
      valid: true;
      name: string;
      normalizedName: string;
      enabled: boolean;
      filePath: string;
    }
  | {
      valid: false;
      rawName: string | null;
      normalizedRawName: string | null;
      filePath: string;
      errors: string[];
    };

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findSkillFiles(
  baseDir: string,
  visited: Set<string> = new Set()
): Promise<string[]> {
  let realPath: string;
  try {
    realPath = await fs.realpath(baseDir);
  } catch {
    return [];
  }

  if (visited.has(realPath)) {
    return [];
  }
  visited.add(realPath);

  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const dirPath = path.join(baseDir, entry.name);
        const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
        if (await pathExists(promptFile)) {
          return [promptFile];
        }
        return findSkillFiles(dirPath, visited);
      })
  );

  return nested.flat();
}

async function loadMissionSkill(filePath: string): Promise<LoadedMissionSkill> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const { metadata } = parseFrontmatter(content);
    const parsed = SkillFrontmatterSchema.safeParse(metadata);

    if (!parsed.success) {
      const rawName =
        typeof metadata.name === 'string' && metadata.name.trim().length > 0
          ? metadata.name
          : null;
      return {
        valid: false,
        rawName,
        normalizedRawName: rawName ? sanitizeSkillName(rawName) : null,
        filePath,
        errors: parsed.error.issues.map((issue) => {
          const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
          return `${where}: ${issue.message}`;
        }),
      };
    }

    return {
      valid: true,
      name: parsed.data.name,
      normalizedName: sanitizeSkillName(parsed.data.name),
      enabled: parsed.data.enabled,
      filePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      rawName: null,
      normalizedRawName: null,
      filePath,
      errors: [`read: ${message}`],
    };
  }
}

function getReferencedMissionWorkerSkills(features: Feature[]): {
  referenced: ReferencedSkill[];
  missingSkillNameFeatureIds: string[];
} {
  const byName = new Map<string, ReferencedSkill>();
  const missingSkillNameFeatureIds: string[] = [];

  for (const feature of features) {
    const skillName =
      typeof feature.skillName === 'string' ? feature.skillName : '';
    if (VALIDATION_SKILL_NAMES.includes(skillName)) {
      continue;
    }

    const normalizedName = sanitizeSkillName(skillName);
    if (!normalizedName) {
      missingSkillNameFeatureIds.push(feature.id);
      continue;
    }

    const existing = byName.get(normalizedName);
    if (existing) {
      existing.featureIds.push(feature.id);
      continue;
    }

    byName.set(normalizedName, {
      requestedName: skillName,
      normalizedName,
      featureIds: [feature.id],
    });
  }

  return {
    referenced: [...byName.values()],
    missingSkillNameFeatureIds,
  };
}

function formatFeatureList(featureIds: string[]): string {
  return featureIds.map((id) => `"${id}"`).join(', ');
}

function formatMissionRelativePath(
  missionDir: string,
  filePath: string
): string {
  const relativePath = path.relative(missionDir, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return filePath;
  }
  return relativePath;
}

function formatMissionRelativeSkillFileList(
  missionDir: string,
  skills: LoadedMissionSkill[]
): string {
  return skills
    .map((skill) => formatMissionRelativePath(missionDir, skill.filePath))
    .join(', ');
}

function getLikelySkillFilesByDirName(params: {
  loadedSkills: LoadedMissionSkill[];
  normalizedName: string;
}): LoadedMissionSkill[] {
  return params.loadedSkills.filter(
    (skill) =>
      sanitizeSkillName(path.basename(path.dirname(skill.filePath))) ===
      params.normalizedName
  );
}

export async function validateMissionScopedFeatureSkills(params: {
  missionDir: string;
  features: Feature[];
}): Promise<MissionScopedFeatureSkillsValidationResult> {
  const { referenced, missingSkillNameFeatureIds } =
    getReferencedMissionWorkerSkills(params.features);
  if (referenced.length === 0 && missingSkillNameFeatureIds.length === 0) {
    return { ok: true };
  }

  const skillsDir = path.join(params.missionDir, 'skills');
  const skillFiles = await findSkillFiles(skillsDir);
  const loadedSkills = await Promise.all(skillFiles.map(loadMissionSkill));

  const issues: string[] = [];
  for (const featureId of missingSkillNameFeatureIds) {
    issues.push(`Feature "${featureId}" is missing a skillName.`);
  }

  for (const referencedSkill of referenced) {
    const matchingByName = loadedSkills.filter((skill) =>
      skill.valid
        ? skill.normalizedName === referencedSkill.normalizedName
        : skill.normalizedRawName === referencedSkill.normalizedName
    );

    if (matchingByName.length > 1) {
      issues.push(
        `Duplicate skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
          referencedSkill.featureIds
        )}: ${formatMissionRelativeSkillFileList(
          params.missionDir,
          matchingByName
        )}. Skill names must be unique.`
      );
      continue;
    }

    const matching = matchingByName[0];
    if (!matching) {
      const likelySkillFiles = getLikelySkillFilesByDirName({
        loadedSkills,
        normalizedName: referencedSkill.normalizedName,
      });
      const likelySkillFile = likelySkillFiles[0];
      if (likelySkillFile && !likelySkillFile.valid) {
        issues.push(
          `Invalid skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
            referencedSkill.featureIds
          )} at ${formatMissionRelativePath(
            params.missionDir,
            likelySkillFile.filePath
          )}: ${likelySkillFile.errors.join('; ')}.`
        );
        continue;
      }
      if (likelySkillFile?.valid) {
        issues.push(
          `Skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
            referencedSkill.featureIds
          )} has mismatched frontmatter at ${formatMissionRelativePath(
            params.missionDir,
            likelySkillFile.filePath
          )}: name is "${likelySkillFile.name}".`
        );
        continue;
      }
      issues.push(
        `Missing skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
          referencedSkill.featureIds
        )}. Expected skills/${referencedSkill.normalizedName}/${SKILL_PROMPT_FILE}.`
      );
      continue;
    }

    if (!matching.valid) {
      issues.push(
        `Invalid skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
          referencedSkill.featureIds
        )} at ${formatMissionRelativePath(params.missionDir, matching.filePath)}: ${matching.errors.join('; ')}.`
      );
      continue;
    }

    if (!matching.enabled) {
      issues.push(
        `Disabled skill "${referencedSkill.requestedName}" for feature(s) ${formatFeatureList(
          referencedSkill.featureIds
        )} at ${formatMissionRelativePath(params.missionDir, matching.filePath)}.`
      );
    }
  }

  if (issues.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    userError:
      'Mission worker skills are not ready. Run define-mission-skills.',
    llmError:
      `Cannot start mission: worker skills are not ready.\n` +
      `${issues.map((issue) => `- ${issue}`).join('\n')}\n\n` +
      `Run define-mission-skills, then ensure each feature.skillName has a matching mission skill at {missionDir}/skills/<skill>/SKILL.md with name + description frontmatter. Repo/user-level skills are not sufficient.`,
  };
}
