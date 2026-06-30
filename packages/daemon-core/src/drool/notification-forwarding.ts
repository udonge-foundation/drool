import { z } from 'zod';

import { SessionNotificationType } from '@industry/drool-sdk-ext/protocol/drool';

const IPC_OWNER_NOTIFICATION_DENYLIST = new Set<string>([
  SessionNotificationType.MCP_STATUS_CHANGED,
  SessionNotificationType.MCP_AUTH_REQUIRED,
  SessionNotificationType.MCP_AUTH_COMPLETED,
  SessionNotificationType.ASSISTANT_TEXT_DELTA,
  SessionNotificationType.ASSISTANT_TEXT_COMPLETE,
  SessionNotificationType.THINKING_TEXT_DELTA,
  SessionNotificationType.THINKING_TEXT_COMPLETE,
  SessionNotificationType.TOOL_CALL,
  SessionNotificationType.TOOL_RESULT,
  SessionNotificationType.TOOL_PROGRESS_UPDATE,
  SessionNotificationType.STRUCTURED_OUTPUT,
]);

const NotificationTypeSchema = z.object({
  params: z.object({
    notification: z.object({ type: z.string() }),
  }),
});

export function shouldForwardNotificationToFilteredListener(notification: {
  type: string;
}): boolean {
  return !IPC_OWNER_NOTIFICATION_DENYLIST.has(notification.type);
}

export function shouldForwardToFilteredListener(message: unknown): boolean {
  const parsed = NotificationTypeSchema.safeParse(message);
  return (
    !parsed.success ||
    shouldForwardNotificationToFilteredListener(parsed.data.params.notification)
  );
}
