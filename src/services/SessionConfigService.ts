import {
  extractExecutableInvocations,
  extractNormalizedCommands,
  normalizeCommandExecutables,
} from '@industry/utils/shell';

import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_BLOCKLIST,
  DEFAULT_COMMAND_DENYLIST,
} from '@/services/constants';
import { getSettingsService } from '@/services/SettingsService';
import { SessionConfig } from '@/services/types';

class SessionConfigService {
  private static readonly DENYLIST_EXCLUDED_PATH_PREFIXES = ['/tmp'];

  private config: SessionConfig = {
    toolConfirmation: {
      commandAllowList: new Set<string>(),
    },
  };

  private initialized = false;

  // Store original denylist patterns for regex matching
  private denyListPatterns: string[] = [];

  // Store original blocklist (hard denylist) patterns for regex matching.
  // Blocked commands can never run and can never be approved.
  private blockListPatterns: string[] = [];

  private extractCommands(fullCommand: string): string[] {
    return extractNormalizedCommands(fullCommand);
  }

  private loadCommandPolicy(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    // Skip loading settings during tests, use minimal defaults
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.VITEST_WORKER_ID !== undefined
    ) {
      // Minimal defaults for tests
      this.config.toolConfirmation.commandAllowList.clear();
      this.denyListPatterns = [];
      this.blockListPatterns = [];

      DEFAULT_COMMAND_ALLOWLIST.forEach((cmd) => {
        this.config.toolConfirmation.commandAllowList.add(cmd);
      });

      DEFAULT_COMMAND_DENYLIST.forEach((cmd) => {
        // Store original pattern for regex matching
        this.denyListPatterns.push(cmd);
      });

      DEFAULT_COMMAND_BLOCKLIST.forEach((cmd) => {
        this.blockListPatterns.push(cmd);
      });
      return;
    }

    const settingsService = getSettingsService();

    // Load allowlist from settings
    const allowList = settingsService.getCommandAllowlist();
    const denyList = settingsService.getCommandDenylist();
    const blockList = settingsService.getCommandBlocklist();

    // Clear existing lists
    this.config.toolConfirmation.commandAllowList.clear();
    this.denyListPatterns = [];
    this.blockListPatterns = [];

    // Process allowlist
    allowList
      .map((cmd) => cmd?.trim())
      .filter((cmd): cmd is string => !!cmd)
      .forEach((cmd) => {
        this.extractCommands(cmd).forEach((extracted) => {
          this.config.toolConfirmation.commandAllowList.add(extracted);
        });
      });

    // Process denylist (always require confirmation) and blocklist (can never
    // run or be approved). Both store their raw patterns for regex matching and
    // strip any overlapping allowlist entries so they can't auto-run.
    this.loadPatternList(denyList, this.denyListPatterns);
    this.loadPatternList(blockList, this.blockListPatterns);
  }

  /**
   * Load a raw deny/block pattern list into `target` and remove any overlapping
   * commands from the allowlist, so a denied/blocked command can never auto-run.
   */
  private loadPatternList(rawList: string[], target: string[]): void {
    rawList
      .map((cmd) => cmd?.trim())
      .filter((cmd): cmd is string => !!cmd)
      .forEach((cmd) => {
        target.push(cmd);

        this.extractCommands(cmd).forEach((extracted) => {
          this.config.toolConfirmation.commandAllowList.delete(extracted);
        });
      });
  }

  /**
   * Get the extracted command(s) from a full command string.
   * Uses a simple approach: finds command words and handles git/npm subcommands specially.
   */
  public getExtractedCommands(fullCommand: string): string[] {
    this.loadCommandPolicy();
    return this.extractCommands(fullCommand);
  }

  public addAllowedCommand(fullCommand: string): void {
    const commands = this.getExtractedCommands(fullCommand);
    commands.forEach((cmd) => {
      this.config.toolConfirmation.commandAllowList.add(cmd);
    });
  }

  public isCommandAllowed(fullCommand: string): boolean {
    this.loadCommandPolicy();
    const commands = this.getExtractedCommands(fullCommand);
    // All commands must be allowed for the full command to be allowed
    return commands.every((cmd) =>
      this.config.toolConfirmation.commandAllowList.has(cmd)
    );
  }

  private getMatchingDenylistPattern(command: string): string | null {
    return this.getMatchingPattern(command, this.denyListPatterns);
  }

  /**
   * Blocklist matching is anchored to the executable position of every parsed
   * invocation (recursively including shell-wrapper `-c` payloads and command
   * substitutions). Blocked names appearing only in inert argument text (e.g.
   * `echo shutdown`) therefore do not hard-block, while real executions cannot
   * evade matching via wrappers, prefixes, substitutions, quoting, or paths.
   */
  private getMatchingBlocklistPattern(command: string): string | null {
    if (this.blockListPatterns.length === 0) {
      return null;
    }

    const invocations = extractExecutableInvocations(command);
    if (invocations.length === 0) {
      return null;
    }

    for (const blockedPattern of this.blockListPatterns) {
      if (!blockedPattern || !blockedPattern.trim()) {
        continue;
      }

      const tokens = blockedPattern.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length === 0) {
        continue;
      }

      const pattern = SessionConfigService.buildPatternRegex(tokens, {
        anchored: true,
      });
      if (!pattern) {
        continue;
      }

      if (invocations.some((invocation) => pattern.test(invocation))) {
        return blockedPattern.trim();
      }
    }

    return null;
  }

  /**
   * Candidate strings a pattern is tested against. Includes the raw command,
   * a form where each segment's executable token is normalized (quotes and
   * leading path components stripped), and every parsed invocation (including
   * shell-wrapper payloads and command substitution bodies) so patterns can't
   * be bypassed with shell-valid forms like `"rm" -rf /`, `/bin/rm -rf /`,
   * `bash -c "rm -rf /"`, or `echo $(rm -rf /)`.
   */
  private getMatchCandidates(command: string): string[] {
    const candidates = new Set<string>([command]);

    const normalized = normalizeCommandExecutables(command);
    if (normalized) {
      candidates.add(normalized);
    }

    // Keep argument quoting so denylist matching still treats quoted text as
    // inert data (e.g. `echo "rm -rf /" is dangerous` stays unmatched).
    for (const invocation of extractExecutableInvocations(command, {
      dequoteArguments: false,
    })) {
      candidates.add(invocation);
    }

    return [...candidates];
  }

  private getMatchingPattern(
    command: string,
    patterns: string[]
  ): string | null {
    const candidates = this.getMatchCandidates(command);

    // Check against original patterns using regex
    for (const deniedPattern of patterns) {
      // Skip empty or whitespace-only patterns
      if (!deniedPattern || !deniedPattern.trim()) {
        continue;
      }

      const tokens = deniedPattern.split(/\s+/).filter((t) => t.length > 0);

      // Skip if no valid tokens after filtering
      if (tokens.length === 0) {
        continue;
      }

      const pattern = SessionConfigService.buildPatternRegex(tokens, {
        anchored: false,
      });
      if (!pattern) {
        // Skip malformed patterns but continue checking others
        continue;
      }

      if (candidates.some((candidate) => pattern.test(candidate))) {
        return deniedPattern.trim();
      }
    }

    return null;
  }

  /**
   * Build the regex for a denylist/blocklist pattern's tokens. Anchored mode
   * requires the first token at the start of the candidate (the executable
   * position of a parsed invocation); unanchored mode accepts any command
   * boundary, including `(` and backtick so substitutions match.
   */
  private static buildPatternRegex(
    tokens: string[],
    options: { anchored: boolean }
  ): RegExp | null {
    const escapedTokens = tokens.map((token) =>
      token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

    const leading = options.anchored ? '^' : '(^|[\\s;&|(`]+)';
    // Backtick closes command substitutions, so it is a valid trailing boundary
    const trailing = '([\\s;&|)`]+|$)';
    const wordBoundary = /\w$/.test(tokens[0]) ? '\\b' : '';

    try {
      if (tokens.length === 1) {
        return new RegExp(
          `${leading}${escapedTokens[0]}${wordBoundary}${trailing}`,
          'i'
        );
      }

      const patternParts = [`${leading}${escapedTokens[0]}${wordBoundary}`];

      // Build pattern parts for middle tokens (if any exist)
      // For 2-token patterns, this loop doesn't execute (correct behavior)
      for (let i = 1; i < escapedTokens.length - 1; i++) {
        const nextOriginalToken = tokens[i + 1];
        if (nextOriginalToken === '/' || nextOriginalToken?.startsWith('/')) {
          // Limit length to prevent catastrophic backtracking
          patternParts.push(`[^;&|.]{0,100}${escapedTokens[i]}`);
        } else {
          // Limit length to prevent catastrophic backtracking
          patternParts.push(`[^;&|]{0,100}${escapedTokens[i]}`);
        }
      }

      // For the last token, determine the appropriate boundary
      const lastToken = escapedTokens[escapedTokens.length - 1];
      const originalLastToken = tokens[tokens.length - 1];

      // Special handling for path-based patterns
      if (originalLastToken === '/') {
        // For root (/), ensure it's not preceded by . (to avoid matching ./)
        // Limit length to prevent catastrophic backtracking
        patternParts.push(`[^;&|.]{0,100}${lastToken}`);
      } else if (originalLastToken === '~') {
        // For home (~), match as a path prefix
        // Limit length to prevent catastrophic backtracking
        patternParts.push(`[^;&|]{0,100}${lastToken}`);
      } else if (originalLastToken === '.') {
        // For current directory (.), require it to be followed by a boundary
        // Limit length to prevent catastrophic backtracking
        patternParts.push(`[^;&|]{0,100}${lastToken}${trailing}`);
      } else if (originalLastToken?.startsWith('/')) {
        // For paths starting with /, don't allow . before them
        // Limit length to prevent catastrophic backtracking
        patternParts.push(`[^;&|.]{0,100}${lastToken}${trailing}`);
      } else {
        // For other patterns, require a boundary at the end
        // Limit length to prevent catastrophic backtracking
        patternParts.push(`[^;&|]{0,100}${lastToken}${trailing}`);
      }

      return new RegExp(patternParts.join(''), 'i');
    } catch {
      return null;
    }
  }

  private checkAgainstDenylistPatterns(command: string): boolean {
    return this.getMatchingDenylistPattern(command) !== null;
  }

  private isTargetingOnlyExcludedPaths(command: string): boolean {
    const segments = command.split(/\s*(?:&&|\|\|?|;)\s*/);
    let foundDeniedRm = false;

    for (const segment of segments) {
      const trimmed = segment.trim();
      const rmMatch = trimmed.match(/(?:^|\s)(?:sudo\s+)?rm\s+(.*)/i);
      if (!rmMatch) {
        if (this.checkAgainstDenylistPatterns(trimmed)) {
          return false;
        }
        continue;
      }
      if (!this.checkAgainstDenylistPatterns(trimmed)) {
        continue;
      }

      foundDeniedRm = true;
      const args = rmMatch[1].split(/\s+/).filter((a) => a.length > 0);
      const paths = args.filter((a) => !a.startsWith('-'));
      if (paths.length === 0) {
        return false;
      }

      for (const p of paths) {
        if (p.includes('..') || /[$`]/.test(p)) {
          return false;
        }
        const isExcluded =
          SessionConfigService.DENYLIST_EXCLUDED_PATH_PREFIXES.some(
            (prefix) => p === prefix || p.startsWith(`${prefix}/`)
          );
        if (!isExcluded) {
          return false;
        }
      }
    }
    return foundDeniedRm;
  }

  public isCommandDenied(fullCommand: string): boolean {
    return this.getDeniedCommandPattern(fullCommand) !== null;
  }

  /**
   * Whether a command is hard-blocked. Unlike a denied command (which can be
   * manually approved), a blocked command can never run and can never be
   * approved, and does not honor the denylist's excluded-path carve-out.
   */
  public isCommandBlocked(fullCommand: string): boolean {
    return this.getBlockedCommandPattern(fullCommand) !== null;
  }

  /**
   * Returns the matched blocklist (hard denylist) pattern for a command, or
   * null. Blocked commands can never run and can never be approved, so unlike
   * the denylist this does NOT honor the excluded-path (e.g. /tmp) carve-out.
   */
  public getBlockedCommandPattern(fullCommand: string): string | null {
    this.loadCommandPolicy();
    return this.getMatchingBlocklistPattern(fullCommand);
  }

  public getDeniedCommandPattern(fullCommand: string): string | null {
    this.loadCommandPolicy();

    const matchedPattern = this.getMatchingDenylistPattern(fullCommand);
    if (!matchedPattern) {
      return null;
    }

    // Allow commands that exclusively target excluded paths (e.g. /tmp)
    // to flow through normal risk-level confirmation instead of being hard-blocked
    if (this.isTargetingOnlyExcludedPaths(fullCommand)) {
      return null;
    }

    return matchedPattern;
  }

  // Reset the config (useful for testing or new sessions)
  public reset(): void {
    this.initialized = false;
    this.config = {
      toolConfirmation: {
        commandAllowList: new Set<string>(),
      },
    };
    this.denyListPatterns = [];
    this.blockListPatterns = [];
  }
}

// Export singleton instance
export const sessionConfigService = new SessionConfigService();
