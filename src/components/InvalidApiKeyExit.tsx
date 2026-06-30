import { Box, Text, useStdin, useStdout } from 'ink';

import { logWarn } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { useMountEffect } from '@/hooks/useMountEffect';
import { exitWithCode } from '@/utils/exitWithCode';
import { restoreShellTerminalState } from '@/utils/interactiveTerminalState';

interface InvalidApiKeyExitProps {
  message: string;
}

/**
 * Terminal state for a configured-but-invalid INDUSTRY_API_KEY.
 *
 * With strict API-key precedence (CLI-135) a bad key shadows any stored WorkOS
 * session, so interactive login can never take effect. Mirror how other CLIs
 * treat an explicit-but-broken credential env var: show the actionable error
 * and exit non-zero instead of falling back to the login menu. The frame stays
 * on screen because the shutdown coordinator exits the process abruptly without
 * unmounting Ink.
 */
export function InvalidApiKeyExit({ message }: InvalidApiKeyExitProps) {
  const { setRawMode } = useStdin();
  const { stdout } = useStdout();

  useMountEffect(() => {
    void (async () => {
      // exitWithCode goes straight through the shutdown coordinator to
      // process.exit, bypassing main.tsx's restoreShellTerminalState (which
      // only runs after app.waitUntilExit). Restore it here, best-effort, so
      // the forced exit does not leave the user's shell in raw mode with the
      // cursor hidden or bracketed paste / focus reporting still enabled.
      try {
        await restoreShellTerminalState({ setRawMode, stdout });
      } catch (error) {
        // Best-effort, but surface the failure: a broken restore can leave the
        // shell in raw mode / cursor hidden with no other signal before exit.
        logWarn('[InvalidApiKeyExit] Failed to restore shell terminal state', {
          error,
        });
      }
      await exitWithCode(1);
    })();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.error}>{message}</Text>
    </Box>
  );
}
