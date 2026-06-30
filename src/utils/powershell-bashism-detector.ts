/**
 * Detects common Bash/Unix syntax patterns that will fail when executed
 * in PowerShell on Windows. Used for pre-execution validation to provide
 * actionable error messages instead of cryptic PowerShell failures.
 *
 * This addresses the most common failure modes:
 * - `&&` / `||` operators (not supported in PowerShell 5.1)
 * - Unix commands (grep, head, tail, which) that don't exist in PowerShell
 * - `export VAR=value` (Bash built-in, not available in PowerShell)
 * - `/dev/null` (Unix null device, doesn't exist on Windows)
 * - `rm -rf` with combined Unix-style flags (individual -r/-f are valid in PowerShell)
 * - `curl` with Unix flags (aliased to Invoke-WebRequest in PowerShell)
 */

import { BashismDetection } from '@/utils/types';

/**
 * Check if a character sequence appears outside of single/double quotes.
 * Used for operator detection (&&, ||, /dev/null).
 */
function containsUnquotedSequence(command: string, sequence: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i <= command.length - sequence.length; i++) {
    const char = command[i];
    const prev = i > 0 ? command[i - 1] : '';

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
    }

    if (!inSingle && !inDouble) {
      if (command.substring(i, i + sequence.length) === sequence) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the portions of a command that are outside of quotes.
 * Returns only the unquoted text for pattern matching.
 */
function getUnquotedText(command: string): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const prev = i > 0 ? command[i - 1] : '';

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      result += ' ';
      continue;
    }
    if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      result += ' ';
      continue;
    }

    if (inSingle || inDouble) {
      result += ' ';
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Test if a regex matches any unquoted portion of the command.
 * Used for pattern matching that should ignore quoted strings.
 */
function matchesUnquoted(command: string, pattern: RegExp): boolean {
  return pattern.test(getUnquotedText(command));
}

/**
 * Split a command string into segments by shell operators (&&, ||, |, ;).
 * Respects single and double quoting so operators inside strings are ignored.
 */
function getCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];
    const prev = i > 0 ? command[i - 1] : '';

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (inSingle || inDouble) {
      current += char;
      continue;
    }

    // Split on shell operators
    if (char === ';') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    if (char === '|') {
      if (next === '|') {
        // || operator
        if (current.trim()) segments.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      // Single pipe
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    if (char === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Check if a command name appears at a "command position" in any segment.
 * A command position is the first word of a segment (after optional env var
 * assignments like VAR=value).
 */
function hasCommandAtPosition(segments: string[], cmd: string): boolean {
  return segments.some((segment) => {
    let trimmed = segment.trim();

    // Strip leading environment variable assignments: VAR=value command
    // Supports both unquoted (VAR=value) and quoted (VAR="val ue", VAR='val ue') values
    // to avoid corrupting segments with quoted values.
    const envAssignmentUnquoted = /^[A-Za-z_]\w*=\S+\s+/;
    const envAssignmentDoubleQuoted = /^[A-Za-z_]\w*="[^"]*"\s+/;
    const envAssignmentSingleQuoted = /^[A-Za-z_]\w*='[^']*'\s+/;

    let changed = true;
    while (changed) {
      changed = false;
      // Try quoted patterns first (they're more specific)
      for (const pattern of [
        envAssignmentDoubleQuoted,
        envAssignmentSingleQuoted,
        envAssignmentUnquoted,
      ]) {
        if (pattern.test(trimmed)) {
          trimmed = trimmed.replace(pattern, '');
          changed = true;
          break;
        }
      }
    }

    return (
      trimmed === cmd ||
      trimmed.startsWith(`${cmd} `) ||
      trimmed.startsWith(`${cmd}\t`)
    );
  });
}

/**
 * Detect Bash/Unix syntax patterns in a command that would fail in PowerShell.
 *
 * @param command - The command string to check
 * @param options.isLegacyPowerShell - Set to true when running on PowerShell 5.1
 *   (powershell.exe). This enables additional checks for && and || operators
 *   that are only unsupported in legacy PowerShell.
 * @returns Array of detected bash-isms (empty if command is PowerShell-compatible)
 */
export function detectPowerShellBashisms(
  command: string,
  options?: { isLegacyPowerShell?: boolean }
): BashismDetection[] {
  if (!command || !command.trim()) {
    return [];
  }

  const detections: BashismDetection[] = [];
  const isLegacy = options?.isLegacyPowerShell ?? false;

  // ── Legacy PowerShell 5.1 specific ──────────────────────────────────────
  if (isLegacy) {
    if (containsUnquotedSequence(command, '&&')) {
      detections.push({
        bashism: '&&',
        reason: 'The "&&" operator is not supported in Windows PowerShell 5.1',
        suggestion: 'Use ";" to chain commands, or run each command separately',
      });
    }
    if (containsUnquotedSequence(command, '||')) {
      detections.push({
        bashism: '||',
        reason: 'The "||" operator is not supported in Windows PowerShell 5.1',
        suggestion:
          'Use separate commands with "if ($LASTEXITCODE -ne 0) { <fallback> }"',
      });
    }
  }

  // ── Always flag on Windows PowerShell (any version) ─────────────────────

  const segments = getCommandSegments(command);

  // export VAR=value
  if (hasCommandAtPosition(segments, 'export')) {
    const hasAssignment = segments.some((seg) =>
      /^export\s+[A-Za-z_]\w*=/.test(seg.trim())
    );
    if (hasAssignment) {
      detections.push({
        bashism: 'export',
        reason: '"export" is a Bash built-in, not available in PowerShell',
        suggestion:
          'Use $env:VAR = "value" to set environment variables in PowerShell',
      });
    }
  }

  // source script.sh
  if (hasCommandAtPosition(segments, 'source')) {
    detections.push({
      bashism: 'source',
      reason: '"source" is a Bash built-in, not available in PowerShell',
      suggestion: 'Use dot-sourcing instead: . .\\script.ps1',
    });
  }

  // /dev/null
  if (containsUnquotedSequence(command, '/dev/null')) {
    detections.push({
      bashism: '/dev/null',
      reason: '/dev/null does not exist on Windows',
      suggestion: 'Use $null instead of /dev/null',
    });
  }

  // rm with combined Unix-style flags (-rf, -fr) that are not valid in PowerShell.
  // Individual -r or -f ARE valid in PowerShell (they bind to -Recurse/-Force),
  // so we only flag combined flags like -rf, -fr, -Rf, etc.
  if (segments.some((seg) => /^rm\s+-[rRfF]{2,}/.test(seg.trim()))) {
    detections.push({
      bashism: 'rm -rf',
      reason:
        '"rm -rf" with combined Unix-style flags does not work in PowerShell',
      suggestion: 'Use Remove-Item -Recurse -Force <path> instead',
    });
  }

  // ps aux / ps -ef / ps -a (Unix ps flags)
  if (segments.some((seg) => /^ps\s+(aux\b|-[aef])/.test(seg.trim()))) {
    detections.push({
      bashism: 'ps aux',
      reason: '"ps" with Unix-style flags is not available in PowerShell',
      suggestion: 'Use Get-Process instead',
    });
  }

  // grep (standalone command, not git grep)
  if (hasCommandAtPosition(segments, 'grep')) {
    detections.push({
      bashism: 'grep',
      reason: '"grep" is not available in PowerShell',
      suggestion: 'Use Select-String -Pattern "pattern" instead of grep',
    });
  }

  // head (standalone command)
  if (hasCommandAtPosition(segments, 'head')) {
    detections.push({
      bashism: 'head',
      reason: '"head" is not available in PowerShell',
      suggestion:
        'Use Get-Content <file> -Head <N> or Select-Object -First <N>',
    });
  }

  // tail (standalone command)
  if (hasCommandAtPosition(segments, 'tail')) {
    detections.push({
      bashism: 'tail',
      reason: '"tail" is not available in PowerShell',
      suggestion:
        'Use Get-Content <file> -Tail <N> or Get-Content -Wait for tail -f',
    });
  }

  // which
  if (hasCommandAtPosition(segments, 'which')) {
    detections.push({
      bashism: 'which',
      reason: '"which" is not available in PowerShell',
      suggestion: 'Use Get-Command <name> instead',
    });
  }

  // awk
  if (hasCommandAtPosition(segments, 'awk')) {
    detections.push({
      bashism: 'awk',
      reason: '"awk" is not available in PowerShell',
      suggestion:
        'Use ForEach-Object / Select-Object / -split / Where-Object for column extraction',
    });
  }

  // sed
  if (hasCommandAtPosition(segments, 'sed')) {
    detections.push({
      bashism: 'sed',
      reason: '"sed" is not available in PowerShell',
      suggestion:
        'Use the -replace operator: (Get-Content file) -replace "old","new" | Set-Content file',
    });
  }

  // xargs
  if (hasCommandAtPosition(segments, 'xargs')) {
    detections.push({
      bashism: 'xargs',
      reason: '"xargs" is not available in PowerShell',
      suggestion:
        'Use ForEach-Object (alias %): "Get-ChildItem | ForEach-Object { ... }"',
    });
  }

  // find with Unix-style flags. Bare `find` overlaps with PowerShell verbs
  // (Find-Module, etc.) so we only flag invocations that include a Unix
  // flag like -name / -type / -path / -maxdepth / -mindepth / -newer / -mtime / -delete.
  if (
    segments.some((seg) =>
      /^find\s+\S+\s+-(name|type|path|maxdepth|mindepth|newer|mtime|delete)\b/.test(
        seg.trim()
      )
    )
  ) {
    detections.push({
      bashism: 'find',
      reason: '"find" with Unix flags is not available in PowerShell',
      suggestion:
        'Use Get-ChildItem -Recurse -Filter "*.ts" or Get-ChildItem -Recurse | Where-Object { ... }',
    });
  }

  // bash / sh / zsh standalone (excludes bash.exe / sh.exe wrappers)
  if (
    segments.some((seg) => {
      const trimmed = seg.trim();
      return (
        /^(bash|sh|zsh)\s/.test(trimmed) &&
        !/^bash\.exe\b|^sh\.exe\b|^zsh\.exe\b/i.test(trimmed)
      );
    })
  ) {
    detections.push({
      bashism: 'bash/sh/zsh',
      reason:
        'Invoking bash/sh/zsh directly is typically unavailable on Windows',
      suggestion:
        'Run the command directly in PowerShell, or use wsl.exe for WSL interop',
    });
  }

  // Bash conditional syntax: "if [ ... ]" or "[[ ... ]]" at command position.
  if (
    segments.some((seg) => {
      const trimmed = seg.trim();
      return (
        /^if\s+\[\[?\s/.test(trimmed) ||
        /^\[\[\s/.test(trimmed) ||
        /^if\s+test\s/.test(trimmed)
      );
    })
  ) {
    detections.push({
      bashism: 'if [ ] / [[ ]]',
      reason: 'Bash test syntax is not available in PowerShell',
      suggestion:
        'Use PowerShell: if (Test-Path "file") { ... } or if ($var -eq "foo") { ... }',
    });
  }

  // Bash for-loop: "for X in ...; do" pattern. Operates on unquoted text
  // because segmentation splits on `;` and `|`, which breaks the match.
  if (matchesUnquoted(command, /\bfor\s+\S+\s+in\s+.+?;\s*do\b/)) {
    detections.push({
      bashism: 'for ... do',
      reason: 'Bash-style for-loop is not available in PowerShell',
      suggestion:
        'Use foreach ($x in <expr>) { ... } or <expr> | ForEach-Object { ... }',
    });
  }

  // Process substitution: "<(cmd)" or ">(cmd)" — check unquoted text only
  if (
    matchesUnquoted(command, /(?:^|\s)<\s*\(/) ||
    matchesUnquoted(command, /(?:^|\s)>\s*\(/)
  ) {
    detections.push({
      bashism: 'process substitution',
      reason:
        'Process substitution <(...) / >(...) is not available in PowerShell',
      suggestion:
        'Use intermediate variables, $( ... ) subexpressions, or temp files',
    });
  }

  // 2>&1 piped to a Unix tool (combined POSIX pipeline). Check unquoted text
  // because segmentation already split on `|`.
  if (
    matchesUnquoted(
      command,
      /2>&1\s*\|\s*(grep|head|tail|awk|sed|wc|sort|uniq|cut)\b/
    )
  ) {
    detections.push({
      bashism: '2>&1 | <unix-tool>',
      reason:
        'POSIX redirect-and-pipe to a Unix tool — not available in PowerShell',
      suggestion:
        'PowerShell merges streams with "*>&1" and pipes objects: "<cmd> *>&1 | Select-String pattern" or capture with "$out = <cmd> 2>&1"',
    });
  }

  // curl with Unix flags (curl is aliased to Invoke-WebRequest in PS)
  // Only flag segments where the command token is `curl` (not `curl.exe`).
  // curl.exe invokes the native Windows curl binary and works fine.
  // The exemption is per-segment and case-insensitive (Windows executables are case-insensitive).
  if (
    segments.some((seg) => {
      const trimmed = seg.trim();
      return (
        /^curl\s+-[XdHsLoIkvu]/i.test(trimmed) && !/^curl\.exe\b/i.test(trimmed)
      );
    })
  ) {
    detections.push({
      bashism: 'curl (Unix flags)',
      reason:
        '"curl" is aliased to Invoke-WebRequest in PowerShell, which has different parameters',
      suggestion:
        'Use curl.exe for native curl, or Invoke-WebRequest with PowerShell syntax',
    });
  }

  return detections;
}

/**
 * Format bashism detections into an actionable error message for the LLM.
 */
export function formatBashismError(detections: BashismDetection[]): string {
  const issues = detections
    .map((d, i) => `${i + 1}. ${d.reason}\n   → ${d.suggestion}`)
    .join('\n');

  return (
    `This command uses Bash/Unix syntax that is incompatible with PowerShell on this Windows system.\n\n` +
    `Issues detected:\n${issues}\n\n` +
    `Please rewrite the command using PowerShell-compatible syntax.`
  );
}

/**
 * Detect PowerShell-specific error patterns in command output.
 * Used as a post-execution safety net to provide actionable hints
 * when pre-execution detection missed a bash-ism.
 */
export function detectPowerShellOutputError(output: string): string | null {
  if (!output) return null;

  const lowerOutput = output.toLowerCase();

  if (
    lowerOutput.includes("token '&&' is not a valid statement separator") ||
    lowerOutput.includes('token && is not a valid statement')
  ) {
    return 'PowerShell 5.1 does not support the "&&" operator. Use ";" to chain commands, or run each command separately.';
  }

  if (
    lowerOutput.includes("token '||' is not a valid statement separator") ||
    lowerOutput.includes('token || is not a valid statement')
  ) {
    return 'PowerShell 5.1 does not support the "||" operator. Use separate commands with "if ($LASTEXITCODE -ne 0) { <fallback> }".';
  }

  if (
    lowerOutput.includes('is not recognized as the name of a cmdlet') ||
    lowerOutput.includes('is not recognized as an internal or external command')
  ) {
    // Extract the command name from the error
    const match = output.match(
      /['"]?(\w+)['"]?\s*(?:is not recognized as the name of a cmdlet|is not recognized as an internal)/i
    );
    const cmd = match?.[1]?.toLowerCase();
    const knownUnixUtilities = [
      'grep',
      'head',
      'tail',
      'which',
      'awk',
      'sed',
      'cut',
      'sort',
      'uniq',
      'wc',
      'xargs',
      'find',
      'bash',
      'sh',
      'zsh',
    ];
    if (cmd && knownUnixUtilities.includes(cmd)) {
      return `The "${cmd}" command is a Unix utility not available in PowerShell. Use PowerShell equivalents: grep → Select-String, head → Get-Content -Head, tail → Get-Content -Tail, which → Get-Command, awk/sed/cut → ForEach-Object / -split / -replace, xargs → ForEach-Object (alias %), find → Get-ChildItem -Recurse -Filter.`;
    }
  }

  // Cmdlet was invoked with Unix-style flags it doesn't accept. PowerShell
  // surfaces this as "A positional parameter cannot be found that accepts
  // argument '<value>'" or "Cannot find an overload for ...".
  if (
    lowerOutput.includes('a positional parameter cannot be found') ||
    lowerOutput.includes('cannot find an overload')
  ) {
    return 'PowerShell rejected a parameter — you may have used a Unix-style flag (e.g. -X, -H, -n) that the cmdlet does not accept. Run "Get-Help <cmdlet> -Full" to see the correct parameter names, or escape the call to a native binary (e.g. curl.exe instead of curl).';
  }

  return null;
}
