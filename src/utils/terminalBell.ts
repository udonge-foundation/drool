import { getDroolRuntimeService } from '@/services/DroolRuntimeService';

export function emitTerminalBell(): void {
  try {
    const runtimeService = getDroolRuntimeService();
    // Never write to stdout in modes where it carries structured output:
    // - InteractiveCLI (JSON-RPC): stdout is the protocol transport
    // - NonInteractiveCLI (exec): stdout carries result text/JSON
    // Bell characters leak into the output and render as garbage (e.g. '�').
    if (
      runtimeService.isInteractiveCLIMode() ||
      runtimeService.isNonInteractiveCLIMode()
    ) {
      return;
    }

    process.stdout.write('\u0007');
  } catch {
    // ignore environments without stdout
  }
}
