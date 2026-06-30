/**
 * Windows non-ASCII argv mitigation (FAC-19663).
 *
 * Many native Windows tools (java.exe, mvn, gradle via java, msbuild's
 * native bits, older C/C++ CLIs) decode their argv via `GetCommandLineA()`
 * + the system ANSI code page (Cp1252/GBK/etc). Code points outside the
 * active code page are substituted with `?` (U+003F) at the launcher
 * level, *before* any user-visible JVM/CLR property like
 * `sun.jnu.encoding` or `JAVA_TOOL_OPTIONS` can take effect.
 *
 * The chain is otherwise Unicode-correct:
 *   Node.js -> CreateProcessW (Unicode lpCommandLine)
 *   PowerShell -> CreateProcessW
 *   ^ both pass proper UTF-16 to the kernel; the offending tool's own
 *     C runtime is what drops down to ANSI argv.
 *
 * Only mitigation that works (verified on Windows Server 2025 with
 * JDK 25 + Maven 3.9.15, ANSI CP 1252, OEM 437): substitute every
 * absolute path token containing non-ASCII characters with the
 * filesystem's 8.3 short name. NTFS keeps 8.3 enabled by default and
 * the short name is pure ASCII, so the launcher decodes it identically
 * regardless of the active code page.
 *
 * If 8.3 is disabled on the volume or the path doesn't exist, fall back
 * to the longest existing prefix; if that still can't be shortened,
 * leave the token unchanged. Tools that already handle Unicode argv
 * (Node, Python 3.6+, .NET CoreCLR, Go, Rust) accept short paths just
 * as well as long ones, so the substitution is benign for them too.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { logInfo, logWarn } from '@industry/logging';

const winPath = path.win32;

const SHORT_PATH_CACHE_LIMIT = 256;
const SHORT_PATH_RESOLVER_TIMEOUT_MS = 2_500;
const SHORT_PATH_INPUT_ENV = '__INDUSTRY_DROOL_SHORT_PATH_INPUT';
// Caches both successful resolutions (short path) and failures (`null`). The
// negative entries are essential: powershell.exe startup can exceed the
// timeout transiently, and without caching the failure every later command
// re-spawns powershell synchronously (blocking the event loop) and re-logs.
const shortPathCache = new Map<string, string | null>();

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

function rememberResult(longPath: string, result: string | null): void {
  if (shortPathCache.size >= SHORT_PATH_CACHE_LIMIT) {
    const firstKey = shortPathCache.keys().next().value;
    if (firstKey !== undefined) shortPathCache.delete(firstKey);
  }
  shortPathCache.set(longPath, result);
}

/**
 * Resolve a path's 8.3 short name.
 *
 * We pass the long path through an environment variable rather than as an
 * argv entry. On Windows, `lpEnvironment` in `CreateProcessW` is Unicode
 * (`WCHAR*`), but argv parsing for many tools — including cmd.exe's `for`
 * loop and the C runtime of legacy native exes — drops down to ANSI and
 * mangles non-Cp1252 codepoints. PowerShell holds env-var values as native
 * .NET strings (BSTR-equivalent), and `Scripting.FileSystemObject` is a
 * COM API that takes BSTRs, so the entire resolution path stays in
 * Unicode.
 *
 * Returns the short path, or `null` if the path doesn't exist, 8.3 is
 * disabled on the volume, or the resolver fails.
 */
function resolveShortPath(longPath: string): string | null {
  const cached = shortPathCache.get(longPath);
  if (cached !== undefined) return cached;

  if (!fs.existsSync(longPath)) return null;

  const psScript = [
    "$ErrorActionPreference='Stop';",
    `$p=$env:${SHORT_PATH_INPUT_ENV};`,
    'if (-not (Test-Path -LiteralPath $p)) { exit 2 };',
    '$item=Get-Item -LiteralPath $p;',
    '$container = if ($item.PSIsContainer) { $item.FullName } else { $item.DirectoryName };',
    '$leaf      = if ($item.PSIsContainer) { $null } else { $item.Name };',
    '$fso=New-Object -ComObject Scripting.FileSystemObject;',
    '$short = if ($leaf) { $fso.GetFile([System.IO.Path]::Combine($container,$leaf)).ShortPath } else { $fso.GetFolder($container).ShortPath };',
    'Write-Output $short',
  ].join(' ');

  let stdout: string;
  try {
    stdout = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NoLogo',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: SHORT_PATH_RESOLVER_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, [SHORT_PATH_INPUT_ENV]: longPath },
      }
    );
  } catch (error) {
    // A slow/failed powershell.exe spawn (AV scan, COM init, machine load) is
    // recoverable: the path token is left unchanged and the tool still runs.
    // Cache the failure so we don't re-spawn powershell on every later
    // command, and log at warn level instead of escalating to Sentry. The
    // negative cache also de-dupes the log to once per path.
    logWarn('[windowsArgvEncoding] PowerShell short-path resolver failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    rememberResult(longPath, null);
    return null;
  }

  const trimmed = stdout.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed === longPath) {
    rememberResult(longPath, null);
    return null;
  }
  if (hasNonAscii(trimmed)) {
    rememberResult(longPath, null);
    return null;
  }

  rememberResult(longPath, trimmed);
  return trimmed;
}

/**
 * Walk up the path until we find an existing prefix, return its short
 * name plus the leftover suffix. Lets callers handle output paths whose
 * leaf component doesn't exist yet (e.g. `mvn --target C:\非ASCII\out\x.jar`).
 */
function resolveLongestExistingShort(absPath: string): string | null {
  let current = absPath.replace(/\//g, '\\');
  let suffix = '';
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(current)) {
      const shorted = resolveShortPath(current);
      if (!shorted) return null;
      return suffix ? winPath.join(shorted, suffix) : shorted;
    }
    const parent = winPath.dirname(current);
    if (parent === current) return null;
    suffix = suffix
      ? winPath.join(winPath.basename(current), suffix)
      : winPath.basename(current);
    current = parent;
  }
  return null;
}

/**
 * Path-token regexes.
 *
 *   QUOTED_*  - inside `"..."` or `'...'`. Quotes preserve whitespace, so
 *               we extend the body class to include space and tab. The
 *               matching quote character itself is the only delimiter.
 *   BARE      - unquoted shell token. Stops at any whitespace or shell
 *               metacharacter.
 *
 * Only drive-rooted absolute paths (`C:\...`, `C:/...`) are recognised.
 *
 * UNC paths (`\\host\share\...`) are intentionally excluded. The
 * resolver calls `fs.existsSync` on the longest existing prefix, and
 * `fs.existsSync('\\\\host\\share\\...')` triggers an SMB connection to
 * the named host. On Windows that connect attempt performs implicit
 * NTLM/Kerberos authentication using the drool process's current user
 * credentials. An attacker who can influence an argv token (e.g. via a
 * crafted file path rendered back into a follow-up command) could
 * therefore coerce an outbound auth handshake to an attacker-controlled
 * host and capture the NetNTLMv2 response for offline cracking or
 * relay. See also MS-NRPC / KB5005413 ("NTLM relay mitigations"). The
 * mitigation this file implements is specifically about ANSI argv
 * mojibake for *local* tools; UNC paths are out of scope and safer left
 * untouched by this pass.
 *
 * Extended-length (`\\?\C:\...`) and device (`\\.\...`) prefixes are
 * likewise not recognised: the leading `?`/`.` segment disqualifies
 * `Get-Item -LiteralPath` from resolving them predictably; if we ever
 * see them in real traffic we'll add a dedicated branch.
 */
const PATH_PREFIX = `[A-Za-z]:[\\\\/]`;
const QUOTED_DOUBLE_PATH_TOKEN = new RegExp(
  `"(${PATH_PREFIX}[^"\\r\\n]*)"`,
  'g'
);
const QUOTED_SINGLE_PATH_TOKEN = new RegExp(
  `'(${PATH_PREFIX}[^'\\r\\n]*)'`,
  'g'
);
const BARE_PATH_TOKEN = new RegExp(`${PATH_PREFIX}[^\\s"'<>|?*\\r\\n]*`, 'g');

function substituteToken(token: string): {
  rewritten: string;
  changed: boolean;
} {
  if (!hasNonAscii(token)) return { rewritten: token, changed: false };
  const candidate = resolveLongestExistingShort(token);
  if (!candidate || candidate === token) {
    return { rewritten: token, changed: false };
  }
  return { rewritten: candidate, changed: true };
}

/**
 * Replace every absolute path token in `command` containing non-ASCII
 * characters with its 8.3 short equivalent. Idempotent and safe to call
 * unconditionally; returns `command` unchanged when:
 *   - we're not on Windows
 *   - the command has no non-ASCII characters at all
 *   - none of the path tokens resolve to a different short name (8.3
 *     disabled, non-NTFS volume, missing path, etc.)
 *
 * Substitution runs in three passes against the same string:
 *   1. double-quoted path tokens (preserve quotes, allow embedded spaces)
 *   2. single-quoted path tokens (PowerShell literal strings)
 *   3. bare path tokens (whitespace-delimited)
 *
 * After 1 and 2 the substituted bodies are pure ASCII 8.3 names, so the
 * bare pass is a no-op for already-rewritten regions.
 */
export function rewriteCommandForWindowsArgv(command: string): string {
  if (process.platform !== 'win32') return command;
  if (!hasNonAscii(command)) return command;

  let didRewrite = false;

  const replaceQuoted = (input: string, re: RegExp, quote: string): string =>
    input.replace(re, (_match, inner: string) => {
      const { rewritten, changed } = substituteToken(inner);
      if (changed) didRewrite = true;
      return `${quote}${rewritten}${quote}`;
    });

  let next = replaceQuoted(command, QUOTED_DOUBLE_PATH_TOKEN, '"');
  next = replaceQuoted(next, QUOTED_SINGLE_PATH_TOKEN, "'");
  next = next.replace(BARE_PATH_TOKEN, (token) => {
    const { rewritten, changed } = substituteToken(token);
    if (changed) didRewrite = true;
    return rewritten;
  });

  if (didRewrite) {
    logInfo(
      '[windowsArgvEncoding] substituted non-ASCII path(s) with 8.3 short names',
      {
        length: command.length,
        size: next.length,
      }
    );
  }
  return next;
}

export const __testing = Object.freeze({
  hasNonAscii,
  resolveShortPath,
  resolveLongestExistingShort,
  resetCacheForTests(): void {
    shortPathCache.clear();
  },
});
