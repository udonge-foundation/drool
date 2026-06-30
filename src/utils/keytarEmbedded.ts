/**
 * Embedded keytar native module management.
 *
 * Handles the embedded keytar.node binary that is bundled into the CLI SEA build.
 * Extracts the embedded binary to ~/.industry/bin/ and loads it via dlopen.
 *
 * The binary location can be overridden via (in priority order):
 *   1. INDUSTRY_KEYTAR_PATH -- absolute path to keytar.node or its package root
 *   2. INDUSTRY_NPM_MODULES_DIR -- node_modules dir containing keytar
 */

import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import path from 'path';

import { logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import embeddedKeytarDarwinArm64Path from '@assets/native/keytar/keytar-darwin-arm64.node' with { type: 'file' };
import embeddedKeytarLinuxX64Path from '@assets/native/keytar/keytar-linux-x64.node' with { type: 'file' };
import embeddedKeytarWin32X64Path from '@assets/native/keytar/keytar-win32-x64.node' with { type: 'file' };
import { NpmDepKind } from '@/utils/enums';
import { resolveNpmDep } from '@/utils/npmDepResolver';

// Static import from generated location - exists after prepare-keytar.ts runs

import type { KeytarModule } from '@industry/runtime/auth';

const SHA_FILE_NAME = '.keytar-sha256';

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function getEmbeddedKeytarPath(): string {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return embeddedKeytarWin32X64Path;
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return embeddedKeytarLinuxX64Path;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return embeddedKeytarDarwinArm64Path;
  }
  throw new Error(
    `No embedded keytar binary for platform=${process.platform} arch=${process.arch}`
  );
}

/**
 * Extracts the embedded keytar.node to ~/.industry/bin/ and returns the path.
 * Uses SHA verification to only re-extract when the embedded binary changes.
 */
function extractKeytarBinary(): string {
  const binDir = path.join(getIndustryHome(), getIndustryDirName(), 'bin');
  const targetPath = path.join(binDir, 'keytar.node');
  const shaPath = path.join(binDir, SHA_FILE_NAME);
  const embeddedKeytarPath = getEmbeddedKeytarPath();

  const embeddedSha = computeSha256(embeddedKeytarPath);
  let needsExtraction = !existsSync(targetPath);

  if (!needsExtraction && existsSync(shaPath)) {
    const existingSha = readFileSync(shaPath, 'utf8').trim();
    needsExtraction = existingSha !== embeddedSha;
    if (needsExtraction) {
      logInfo('Keytar binary SHA mismatch, updating');
    }
  } else if (!needsExtraction) {
    needsExtraction = true;
  }

  if (needsExtraction) {
    try {
      mkdirSync(binDir, { recursive: true });

      if (existsSync(targetPath)) {
        unlinkSync(targetPath);
      }

      writeFileSync(targetPath, readFileSync(embeddedKeytarPath), {
        mode: 0o755,
      });
      writeFileSync(shaPath, embeddedSha);
      logInfo('Extracted keytar binary', { path: targetPath });
    } catch (error) {
      logWarn('Failed to extract keytar binary', {
        cause: error,
        path: targetPath,
      });
      throw error;
    }
  }

  return targetPath;
}

function loadKeytarFromPath(keytarPath: string): KeytarModule | null {
  try {
    const keytarModule = { exports: {} as KeytarModule };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).dlopen(keytarModule, keytarPath);
    return keytarModule.exports;
  } catch (error) {
    logWarn('Failed to load keytar native module via dlopen', {
      cause: error,
      path: keytarPath,
    });
    return null;
  }
}

let cachedKeytar: KeytarModule | null | undefined;

/**
 * Returns the embedded keytar module, extracting and loading it if necessary.
 * Returns null if keytar cannot be loaded (graceful degradation).
 *
 * Resolution order:
 *   1. INDUSTRY_KEYTAR_PATH per-dep override
 *   2. INDUSTRY_NPM_MODULES_DIR canonical sub-path (keytar/build/Release/keytar.node)
 *   3. Extract embedded binary from CLI SEA bundle
 */
export async function getEmbeddedKeytar(): Promise<KeytarModule | null> {
  if (cachedKeytar !== undefined) {
    return cachedKeytar;
  }

  try {
    // Check for user-provided override before extracting.
    const overridePath = resolveNpmDep(NpmDepKind.Keytar);
    const keytarPath = overridePath ?? extractKeytarBinary();
    cachedKeytar = loadKeytarFromPath(keytarPath);

    if (cachedKeytar) {
      logInfo('Loaded keytar', { path: keytarPath });
    }

    return cachedKeytar;
  } catch (error) {
    logWarn('Failed to load keytar', { cause: error });
    cachedKeytar = null;
    return null;
  }
}
