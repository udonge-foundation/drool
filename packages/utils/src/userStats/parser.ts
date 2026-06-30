import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, join } from 'path';

import { SessionSettings } from '@industry/common/session/settings';
import { logWarn } from '@industry/logging';

import { getIndustryHome } from '../cli';
import { getIndustryDirName } from '../environment';

import type {
  SessionData,
  SessionMessage,
  UserConfig,
  UserSettings,
} from './types';

function isExpectedFsError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getIndustryDir(): string {
  return join(getIndustryHome(), getIndustryDirName());
}

function getSessionsDir(): string {
  return join(getIndustryDir(), 'sessions');
}

/**
 * The CLI encodes session cwds by replacing `/` with `-` (see
 * apps/cli/src/utils/pathSanitization.ts), which collides with literal `-`
 * inside path segments (e.g. `industry-mono` vs `industry/mono`). To recover
 * the real path we walk the filesystem level-by-level, at each step trying
 * to consume the next 1..n raw segments as a single directory name (joined
 * by `-`) and recursing only into segments whose path actually exists.
 * Returns the first surviving candidate, or null if nothing on disk matches.
 *
 * @public
 */
export function decodeSessionDir(dirName: string): string | null {
  const segments = dirName.replace(/^-/, '').split('-').filter(Boolean);
  if (segments.length === 0) return null;

  function recurse(parent: string, idx: number): string | null {
    if (idx === segments.length) return parent;
    for (let span = 1; span <= segments.length - idx; span++) {
      const name = segments.slice(idx, idx + span).join('-');
      const child = parent === '' ? `/${name}` : join(parent, name);
      if (!existsSync(child)) continue;
      const result = recurse(child, idx + span);
      if (result) return result;
    }
    return null;
  }

  return recurse('', 0);
}

function extractProjectInfo(dirName: string): {
  name: string | null;
  path: string | null;
} {
  const home = homedir();
  const homeBase = basename(home);

  if (dirName === `-Users-${homeBase}` || dirName === '-root') {
    return { name: 'root', path: null };
  }

  if (dirName.startsWith('-root-')) {
    return { name: dirName.slice('-root-'.length), path: null };
  }

  if (dirName.startsWith('-Users-') || dirName.startsWith('-root')) {
    const reposMatch = dirName.match(/-repos-(.+)$/);
    if (reposMatch) {
      const projectPart = reposMatch[1];
      const possiblePath = join(homedir(), 'repos', projectPart);
      if (existsSync(possiblePath)) {
        return { name: projectPart, path: possiblePath };
      }
      return { name: projectPart, path: join(homedir(), 'repos', projectPart) };
    }

    const decoded = decodeSessionDir(dirName);
    if (decoded) {
      return { name: basename(decoded), path: decoded };
    }

    const parts = dirName.split('-').filter(Boolean);
    return { name: parts[parts.length - 1], path: null };
  }
  return { name: dirName, path: null };
}

async function parseSession(
  dir: string,
  sessionId: string,
  projectName: string | null,
  projectPath: string | null
): Promise<SessionData | null> {
  const settingsPath = join(dir, `${sessionId}.settings.json`);
  const jsonlPath = join(dir, `${sessionId}.jsonl`);

  let settings: SessionSettings = {};
  let messageCount = 0;
  let userMessageCount = 0;
  let firstTimestamp: Date | null = null;
  let lastTimestamp: Date | null = null;
  let actualModel: string | null = null;
  let cwd: string | null = null;
  const skillsUsed: string[] = [];
  const droolsUsed: string[] = [];

  try {
    const settingsContent = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(settingsContent) as SessionSettings;
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read session settings failed', {
        path: settingsPath,
        cause: error,
      });
  }

  try {
    const jsonlContent = await readFile(jsonlPath, 'utf-8');
    const lines = jsonlContent.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const msg: SessionMessage = JSON.parse(line) as SessionMessage;

        if (msg.type === 'message') {
          messageCount++;
          if (msg.message?.role === 'user') {
            userMessageCount++;
          }

          const timestamp =
            msg.timestamp || (msg.message as { timestamp?: string })?.timestamp;
          if (timestamp) {
            const date = new Date(timestamp);
            if (!firstTimestamp || date < firstTimestamp) {
              firstTimestamp = date;
            }
            if (!lastTimestamp || date > lastTimestamp) {
              lastTimestamp = date;
            }
          }

          if (msg.message?.role === 'assistant') {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                const toolItem = item as {
                  type?: string;
                  name?: string;
                  input?: { skill?: string; subagent_type?: string };
                };
                if (toolItem.type === 'tool_use') {
                  if (toolItem.name === 'Skill' && toolItem.input?.skill) {
                    skillsUsed.push(toolItem.input.skill);
                  } else if (
                    toolItem.name === 'Task' &&
                    toolItem.input?.subagent_type
                  ) {
                    droolsUsed.push(toolItem.input.subagent_type);
                  }
                }
              }
            }
          }

          if (!actualModel && msg.message?.role === 'user') {
            const content = msg.message.content;
            const textContent =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? (
                      content.find(
                        (c: { type?: string }) => c.type === 'text'
                      ) as { text?: string }
                    )?.text
                  : null;
            if (textContent) {
              if (!cwd) {
                const cwdMatch = textContent.match(
                  /Current folder:\s*([^\n]+)/
                );
                if (cwdMatch) {
                  cwd = cwdMatch[1].trim();
                } else {
                  const pwdMatch = textContent.match(/%\s*pwd\s*\n([^\n]+)/);
                  if (pwdMatch) {
                    cwd = pwdMatch[1].trim();
                  }
                }
              }

              const modelMatch = textContent.match(/Model:\s*([^\n]+)/);
              if (modelMatch) {
                actualModel = modelMatch[1].trim();
              }
            }
          }
        } else if (msg.type === 'session_start' && msg.timestamp) {
          const date = new Date(msg.timestamp);
          if (!firstTimestamp || date < firstTimestamp) {
            firstTimestamp = date;
          }
        }
      } catch (error) {
        if (!isExpectedFsError(error))
          logWarn('[userStats] parse session message line failed', {
            path: jsonlPath,
            cause: error,
          });
      }
    }
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read session jsonl failed', {
        path: jsonlPath,
        cause: error,
      });
  }

  if (!firstTimestamp && settings.providerLockTimestamp) {
    firstTimestamp = new Date(settings.providerLockTimestamp);
    lastTimestamp = firstTimestamp;
  }

  let effectiveProjectName = projectName;
  let effectiveProjectPath = projectPath;

  if (cwd && !effectiveProjectPath) {
    const home = homedir();
    if (cwd === '/' || cwd === home) {
      if (!effectiveProjectName) effectiveProjectName = 'root';
    } else if (existsSync(cwd)) {
      effectiveProjectPath = cwd;
      if (!effectiveProjectName) effectiveProjectName = basename(cwd);
    }
  }

  return {
    id: sessionId,
    project: effectiveProjectName,
    projectPath: effectiveProjectPath,
    settings,
    messageCount,
    userMessageCount,
    firstTimestamp,
    lastTimestamp,
    actualModel,
    skillsUsed,
    droolsUsed,
  };
}

async function parseSessionsInDir(
  dir: string,
  projectName: string | null,
  projectPath: string | null,
  sessions: SessionData[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const { name, path } = extractProjectInfo(entry.name);
      await parseSessionsInDir(fullPath, name, path, sessions);
    } else if (entry.name.endsWith('.settings.json')) {
      const sessionId = entry.name.replace('.settings.json', '');
      const session = await parseSession(
        dir,
        sessionId,
        projectName,
        projectPath
      );
      if (session) {
        sessions.push(session);
      }
    }
  }
}

export async function parseAllSessions(): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  const sessionsDir = getSessionsDir();

  try {
    await parseSessionsInDir(sessionsDir, null, null, sessions);
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read sessions dir failed', {
        path: sessionsDir,
        cause: error,
      });
  }

  return sessions;
}

export async function parseSkills(): Promise<string[]> {
  const skillsDir = join(getIndustryDir(), 'skills');
  const skills: string[] = [];

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        skills.push(entry.name);
      }
    }
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read skills dir failed', {
        path: skillsDir,
        cause: error,
      });
  }

  return skills;
}

export async function parseDrools(): Promise<string[]> {
  const droolsDir = join(getIndustryDir(), 'drools');
  const drools: string[] = [];

  try {
    const entries = await readdir(droolsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !entry.name.startsWith('.')
      ) {
        drools.push(entry.name.replace('.md', ''));
      }
    }
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read drools dir failed', {
        path: droolsDir,
        cause: error,
      });
  }

  return drools;
}

function countHooks(hooks: unknown): number {
  if (!hooks || typeof hooks !== 'object') return 0;
  let count = 0;
  for (const key of Object.keys(hooks)) {
    const arr = (hooks as Record<string, unknown>)[key];
    if (Array.isArray(arr)) {
      count += arr.length;
    }
  }
  return count;
}

export async function parseUserSettings(): Promise<UserSettings> {
  const settingsPath = join(getIndustryDir(), 'settings.json');
  const defaults: UserSettings = {
    model: null,
    reasoningEffort: null,
    autonomyMode: null,
    soundsEnabled: false,
    completionSound: null,
    hooksEnabled: false,
    hookCount: 0,
    commandAllowlistCount: 0,
  };

  try {
    const content = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content) as Record<string, unknown>;

    return {
      model: (settings.model as string) || null,
      reasoningEffort: (settings.reasoningEffort as string) || null,
      autonomyMode: (settings.autonomyMode as string) || null,
      soundsEnabled:
        !!settings.enableCompletionBell || !!settings.completionSound,
      completionSound: (settings.completionSound as string) || null,
      hooksEnabled: !!settings.enableHooks,
      hookCount: countHooks(settings.hooks),
      commandAllowlistCount: Array.isArray(settings.commandAllowlist)
        ? settings.commandAllowlist.length
        : 0,
    };
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read user settings failed', {
        path: settingsPath,
        cause: error,
      });
    return defaults;
  }
}

export async function parseUserConfig(): Promise<UserConfig> {
  const configPath = join(getIndustryDir(), 'config.json');
  const defaults: UserConfig = { customModels: [] };

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as Record<string, unknown>;
    const models =
      (config.custom_models as Array<Record<string, string>>) || [];
    return {
      customModels: models.map(
        (m) => m.model_display_name || m.model || 'Unknown'
      ),
    };
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read user config failed', {
        path: configPath,
        cause: error,
      });
    return defaults;
  }
}

const LANGUAGE_MARKERS: Record<string, string[]> = {
  TypeScript: ['tsconfig.json', 'tsconfig.*.json'],
  JavaScript: ['package.json'],
  Python: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  Rust: ['Cargo.toml'],
  Go: ['go.mod'],
  Ruby: ['Gemfile'],
  Java: ['pom.xml', 'build.gradle'],
  Kotlin: ['build.gradle.kts'],
  Swift: ['Package.swift'],
  'C#': ['*.csproj', '*.sln'],
  PHP: ['composer.json'],
  Elixir: ['mix.exs'],
  Scala: ['build.sbt'],
  Haskell: ['stack.yaml', '*.cabal'],
  Zig: ['build.zig'],
};

export async function detectLanguages(
  projectPath: string | null
): Promise<string[]> {
  if (!projectPath || !existsSync(projectPath)) {
    return [];
  }

  const detected: string[] = [];

  for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
    for (const marker of markers) {
      if (marker.includes('*')) {
        try {
          const entries = await readdir(projectPath);
          const [prefix, suffix] = marker.split('*');
          if (
            entries.some(
              (e) =>
                e.startsWith(prefix) &&
                e.endsWith(suffix) &&
                e.length > prefix.length + suffix.length
            )
          ) {
            detected.push(language);
            break;
          }
        } catch (error) {
          if (!isExpectedFsError(error))
            logWarn('[userStats] scan project dir failed', {
              path: projectPath,
              cause: error,
            });
        }
      } else {
        const filePath = join(projectPath, marker);
        if (existsSync(filePath)) {
          detected.push(language);
          break;
        }
      }
    }
  }

  if (detected.includes('TypeScript')) {
    return detected.filter((l) => l !== 'JavaScript');
  }

  return detected;
}

const JS_FRAMEWORK_DEPS: Array<[string, string | string[]]> = [
  ['Next.js', 'next'],
  ['React', 'react'],
  ['Vue', 'vue'],
  ['Nuxt', 'nuxt'],
  ['Svelte', 'svelte'],
  ['SvelteKit', '@sveltejs/kit'],
  ['Angular', '@angular/core'],
  ['Remix', '@remix-run/react'],
  ['Astro', 'astro'],
  ['Gatsby', 'gatsby'],
  ['Solid', 'solid-js'],
  ['Qwik', '@builder.io/qwik'],
  ['Vite', 'vite'],
  ['Tailwind', 'tailwindcss'],
  ['React Native', 'react-native'],
  ['Expo', 'expo'],
  ['Electron', 'electron'],
  ['Express', 'express'],
  ['Fastify', 'fastify'],
  ['NestJS', '@nestjs/core'],
  ['Hono', 'hono'],
  ['Koa', 'koa'],
];

const FILE_FRAMEWORK_MARKERS: Record<string, string[]> = {
  'Next.js': [
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
    'next.config.ts',
  ],
  Nuxt: [
    'nuxt.config.js',
    'nuxt.config.ts',
    'nuxt.config.mjs',
    'nuxt.config.cjs',
  ],
  SvelteKit: ['svelte.config.js', 'svelte.config.ts'],
  Astro: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
  Vite: [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
  ],
};

export async function detectFrameworks(
  projectPath: string | null
): Promise<string[]> {
  if (!projectPath || !existsSync(projectPath)) {
    return [];
  }

  const detected = new Set<string>();

  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<
        string,
        Record<string, unknown>
      >;
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
        ...(pkg.optionalDependencies || {}),
      } as Record<string, unknown>;

      const hasDep = (name: string): boolean =>
        Object.prototype.hasOwnProperty.call(deps, name);

      for (const [label, dep] of JS_FRAMEWORK_DEPS) {
        if (typeof dep === 'string') {
          if (hasDep(dep)) detected.add(label);
        } else if (dep.some((d) => hasDep(d))) detected.add(label);
      }
    } catch (error) {
      if (!isExpectedFsError(error))
        logWarn('[userStats] read package.json failed', {
          path: pkgPath,
          cause: error,
        });
    }
  }

  try {
    const entries = await readdir(projectPath);
    const entrySet = new Set(entries);
    for (const [label, files] of Object.entries(FILE_FRAMEWORK_MARKERS)) {
      if (files.some((f) => entrySet.has(f))) {
        detected.add(label);
      }
    }
  } catch (error) {
    if (!isExpectedFsError(error))
      logWarn('[userStats] read project root failed', {
        path: projectPath,
        cause: error,
      });
  }

  const requirementsPath = join(projectPath, 'requirements.txt');
  const pyprojectPath = join(projectPath, 'pyproject.toml');
  const pipfilePath = join(projectPath, 'Pipfile');
  const setupPyPath = join(projectPath, 'setup.py');

  const pythonPaths = [
    requirementsPath,
    pyprojectPath,
    pipfilePath,
    setupPyPath,
  ].filter((p) => existsSync(p));

  for (const p of pythonPaths) {
    try {
      const content = (await readFile(p, 'utf-8')).toLowerCase();
      if (content.includes('django')) detected.add('Django');
      if (content.includes('flask')) detected.add('Flask');
      if (content.includes('fastapi')) detected.add('FastAPI');
      if (content.includes('streamlit')) detected.add('Streamlit');
      if (content.includes('gradio')) detected.add('Gradio');
    } catch (error) {
      if (!isExpectedFsError(error))
        logWarn('[userStats] read python deps failed', {
          path: p,
          cause: error,
        });
    }
  }

  const goModPath = join(projectPath, 'go.mod');
  if (existsSync(goModPath)) {
    try {
      const content = await readFile(goModPath, 'utf-8');
      const lower = content.toLowerCase();
      if (lower.includes('github.com/gin-gonic/gin')) detected.add('Gin');
      if (lower.includes('github.com/labstack/echo')) detected.add('Echo');
      if (lower.includes('github.com/gofiber/fiber')) detected.add('Fiber');
      if (lower.includes('github.com/go-chi/chi')) detected.add('Chi');
    } catch (error) {
      if (!isExpectedFsError(error))
        logWarn('[userStats] read go.mod failed', {
          path: goModPath,
          cause: error,
        });
    }
  }

  const cargoPath = join(projectPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const content = (await readFile(cargoPath, 'utf-8')).toLowerCase();
      if (content.includes('axum')) detected.add('Axum');
      if (content.includes('actix-web')) detected.add('Actix Web');
      if (content.includes('rocket')) detected.add('Rocket');
      if (content.includes('tauri')) detected.add('Tauri');
    } catch (error) {
      if (!isExpectedFsError(error))
        logWarn('[userStats] read Cargo.toml failed', {
          path: cargoPath,
          cause: error,
        });
    }
  }

  const gemfilePath = join(projectPath, 'Gemfile');
  if (existsSync(gemfilePath)) {
    try {
      const content = (await readFile(gemfilePath, 'utf-8')).toLowerCase();
      if (content.includes("gem 'rails'") || content.includes('gem "rails"'))
        detected.add('Rails');
      if (
        content.includes("gem 'sinatra'") ||
        content.includes('gem "sinatra"')
      )
        detected.add('Sinatra');
    } catch (error) {
      if (!isExpectedFsError(error))
        logWarn('[userStats] read Gemfile failed', {
          path: gemfilePath,
          cause: error,
        });
    }
  }

  return Array.from(detected);
}
