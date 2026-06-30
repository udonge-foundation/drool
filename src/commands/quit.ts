import { CommandResult, SlashCommand } from '@/commands/types';
import { getI18n } from '@/i18n';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { gracefulMissionExit } from '@/services/mission/gracefulMissionExit';
import { getSessionService } from '@/services/SessionService';

// eslint-disable-next-line industry/constants-file-organization
export const quitCommand: SlashCommand = {
  name: 'quit',
  description: 'Exit from the Drool CLI',
  execute: async (_args: string[], context): Promise<CommandResult> => {
    const sessionId = getSessionService().getCurrentSessionId();
    if (sessionId) {
      const controller =
        await getTuiDaemonAdapter().ensureConnectedAndGetController();
      const { crons } = await controller.listCrons({ sessionId });
      const isLeaveConfirmed =
        context.confirmScheduledTaskLeave?.({
          actionKey: 'quit',
          repeatInstruction: getI18n().t(
            'commands:loop.leaveWarning.repeat.quit'
          ),
          taskCount: crons.length,
        }) ?? true;
      if (!isLeaveConfirmed) {
        return { handled: true, shouldRunAgent: false };
      }

      await controller.holdSessionCrons({
        sessionId,
        reason: 'quit',
      });
    }

    // Execute SessionEnd hooks before exiting
    await getSessionService().executeSessionEndHooks('other');
    // Pause any running mission and interrupt active worker before exit
    await gracefulMissionExit();
    await backgroundProcessTracker.killAllProcesses();
    context.appExit();
    return { handled: true, shouldRunAgent: false };
  },
};
