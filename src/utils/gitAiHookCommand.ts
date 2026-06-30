import { DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER } from '@/services/constants';

export function isDroolGitAiCheckpointHookCommand(command: string): boolean {
  return (
    /git-ai(?:\.exe)?(?:["']?\s+|\s+)checkpoint\s+drool(?:\s|$)/i.test(
      command
    ) ||
    command.includes(DROOL_GIT_AI_CHECKPOINT_HOOK_MARKER) ||
    /drool(?:\.exe)?(?:["']?\s+|\s+)git-ai-checkpoint-hook(?:\s|$)/i.test(
      command
    )
  );
}
