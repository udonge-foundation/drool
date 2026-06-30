import { EnvironmentVariable } from '@industry/environment';

import { TMUX_REPEATED_KEY_SEQUENCE_TIMEOUT_MS } from '@/hooks/constants';

const NON_TMUX_REPEATED_KEY_SEQUENCE_RESET_MS = 200;

export function getNonTmuxRepeatedKeySequenceResetMs(): number {
  return NON_TMUX_REPEATED_KEY_SEQUENCE_RESET_MS;
}

export function getRepeatedKeySequenceTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  return env[EnvironmentVariable.TMUX]
    ? TMUX_REPEATED_KEY_SEQUENCE_TIMEOUT_MS
    : undefined;
}
