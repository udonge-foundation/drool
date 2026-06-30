import fs from 'fs';
import os from 'os';
import path from 'path';

function validateSessionId(sessionId: string): boolean {
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0') ||
    sessionId.length === 0
  ) {
    return false;
  }
  return true;
}

function validateSessionPath(
  resolvedPath: string,
  resolvedSessionsDir: string
): boolean {
  if (!resolvedPath.startsWith(resolvedSessionsDir + path.sep)) {
    return false;
  }
  return true;
}

/**
 * Converts a working directory path to the stable directory key used for
 * locally persisted session-scoped state.
 */
export function sanitizePathToDirectoryName(cwd: string): string {
  let expandedPath = cwd;
  if (cwd.startsWith('~/') || cwd === '~') {
    expandedPath = path.join(os.homedir(), cwd.slice(1));
  }

  const absolutePath = path.resolve(expandedPath);
  const canonicalPath = fs.existsSync(absolutePath)
    ? fs.realpathSync(absolutePath)
    : absolutePath;
  const normalized = canonicalPath.replace(/[\\/]+$/, '');

  if (process.platform === 'win32') {
    return `-${normalized.replace(/^([A-Z]):/i, '$1').replace(/[\\/]+/g, '-')}`;
  }
  return `-${normalized.replace(/^\/+/, '').replace(/\/+/g, '-')}`;
}

/**
 * Locate a session's persisted JSONL file under the industry sessions
 * directory, checking the global, btw, and per-project layouts in that order.
 * Validates the session id against path traversal (separators, `..`, null
 * bytes) and confirms the resolved path stays inside the sessions directory;
 * returns null when the id is invalid or no session file exists.
 */
export function findSessionFilePath({
  industryHome,
  industryDirName,
  sessionId,
}: {
  industryHome: string;
  industryDirName: string;
  sessionId: string;
}): string | null {
  if (!validateSessionId(sessionId)) {
    return null;
  }

  const sessionsDir = path.join(industryHome, industryDirName, 'sessions');
  const resolvedSessionsDir = path.resolve(sessionsDir);

  const globalPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(globalPath)) {
    return validateSessionPath(path.resolve(globalPath), resolvedSessionsDir)
      ? globalPath
      : null;
  }

  const btwPath = path.join(sessionsDir, 'btw', `${sessionId}.jsonl`);
  if (fs.existsSync(btwPath)) {
    return validateSessionPath(path.resolve(btwPath), resolvedSessionsDir)
      ? btwPath
      : null;
  }

  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  if (!fs.statSync(sessionsDir).isDirectory()) {
    return null;
  }

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('-')) {
      continue;
    }

    const projectPath = path.join(
      sessionsDir,
      entry.name,
      `${sessionId}.jsonl`
    );
    if (!fs.existsSync(projectPath)) {
      continue;
    }

    return validateSessionPath(path.resolve(projectPath), resolvedSessionsDir)
      ? projectPath
      : null;
  }

  return null;
}
