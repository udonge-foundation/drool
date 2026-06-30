import fs from 'fs/promises';
import path from 'path';

import { logWarn } from '@industry/logging';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import {
  SQUAD_GENERAL_CHANNEL,
  SQUAD_NOTIFICATION_POLL_INTERVAL_MS,
  SQUAD_USER_PARTICIPANT_ID,
  SQUAD_USER_PARTICIPANT_LABEL,
  SQUAD_WAIT_TIMEOUT_SECONDS,
} from '@/services/squad/constants';
import { SquadNotificationType, SquadRole } from '@/services/squad/enums';
import {
  getSquadChannelsDir,
  getSquadDmsDir,
  getSquadNotificationsDir,
  getSquadState,
  recordAgentActivity,
} from '@/services/squad/SquadStateService';
import type {
  SquadBoardMessage,
  SquadBoardNotification,
  SquadBoardSnapshot,
  SquadDmConversationSnapshot,
} from '@/services/squad/types';
import { generateUUID } from '@/utils/uuid';

type SquadQueuedSessionEvent = {
  squadId: string;
  targetAgentId: string;
  type: SquadNotificationType;
  fromAgentId: string;
  content: string;
  channelName?: string;
  parentMessageId?: string;
};

function getChannelPath(squadId: string, channelName: string): string {
  return path.join(getSquadChannelsDir(squadId), `${channelName}.jsonl`);
}

function getNotificationPath(squadId: string, agentId: string): string {
  return path.join(getSquadNotificationsDir(squadId), `${agentId}.jsonl`);
}

function getDmFileName(agentIdA: string, agentIdB: string): string {
  return [agentIdA, agentIdB].sort().join('__');
}

function getDmPath(
  squadId: string,
  agentIdA: string,
  agentIdB: string
): string {
  return path.join(
    getSquadDmsDir(squadId),
    `${getDmFileName(agentIdA, agentIdB)}.jsonl`
  );
}

async function ensureFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '', { flag: 'a' });
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureFile(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

async function overwriteJsonLines(
  filePath: string,
  values: unknown[]
): Promise<void> {
  await ensureFile(filePath);
  const content = values.map((value) => JSON.stringify(value)).join('\n');
  await fs.writeFile(filePath, content ? `${content}\n` : '', 'utf-8');
}

function createMessage(params: {
  authorAgentId: string;
  content: string;
  parentMessageId?: string;
}): SquadBoardMessage {
  return {
    id: generateUUID(),
    authorAgentId: params.authorAgentId,
    content: params.content,
    timestamp: new Date().toISOString(),
    ...(params.parentMessageId
      ? { parentMessageId: params.parentMessageId }
      : {}),
  };
}

function createNotification(params: {
  type: SquadBoardNotification['type'];
  fromAgentId: string;
  messageId: string;
  channelName?: string;
  parentMessageId?: string;
}): SquadBoardNotification {
  return {
    id: generateUUID(),
    type: params.type,
    fromAgentId: params.fromAgentId,
    messageId: params.messageId,
    timestamp: new Date().toISOString(),
    ...(params.channelName ? { channelName: params.channelName } : {}),
    ...(params.parentMessageId
      ? { parentMessageId: params.parentMessageId }
      : {}),
  };
}

function parseMentions(content: string): string[] {
  return Array.from(
    new Set(
      Array.from(content.matchAll(/@([a-zA-Z0-9_-]+)/g)).map(
        (match) => match[1]
      )
    )
  );
}

function formatParticipantLabel(participantId: string): string {
  return participantId === SQUAD_USER_PARTICIPANT_ID
    ? SQUAD_USER_PARTICIPANT_LABEL
    : participantId;
}

function formatMessage(
  message: SquadBoardMessage,
  agentNames: Map<string, string>
): string {
  const author =
    agentNames.get(message.authorAgentId) ??
    formatParticipantLabel(message.authorAgentId);
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `[${timestamp}] ${author}: ${message.content}`;
}

function formatThreadAwareMessages(
  messages: SquadBoardMessage[],
  agentNames: Map<string, string>
): string {
  const topLevelMessages = messages.filter(
    (message) => !message.parentMessageId
  );
  if (topLevelMessages.length === 0) {
    return messages
      .map((message) => formatMessage(message, agentNames))
      .join('\n');
  }

  const lines: string[] = [];
  for (const message of topLevelMessages) {
    lines.push(formatMessage(message, agentNames));

    const replies = messages.filter(
      (candidate) => candidate.parentMessageId === message.id
    );
    for (const reply of replies) {
      lines.push(`  ↳ ${formatMessage(reply, agentNames)}`);
    }
  }

  return lines.join('\n');
}

function formatLatestConversationSummary(
  message: SquadBoardMessage | undefined
): string {
  if (!message) {
    return '';
  }

  if (message.parentMessageId) {
    return `reply in thread ${message.parentMessageId} — ${message.content}`;
  }

  return message.content;
}

async function queueNotification(params: {
  squadId: string;
  agentId: string;
  notification: SquadBoardNotification;
}): Promise<void> {
  await appendJsonLine(
    getNotificationPath(params.squadId, params.agentId),
    params.notification
  );
}

function formatQueuedSessionEventType(type: SquadNotificationType): string {
  switch (type) {
    case SquadNotificationType.DM:
      return 'DM';
    case SquadNotificationType.Mention:
      return 'Mention';
    case SquadNotificationType.Thread:
      return 'Thread reply';
    default:
      return 'Squad event';
  }
}

function formatQueuedSessionEventContext(
  event: SquadQueuedSessionEvent
): string {
  switch (event.type) {
    case SquadNotificationType.DM:
      return 'direct message';
    case SquadNotificationType.Mention:
      if (event.parentMessageId) {
        return event.channelName
          ? `mention in thread ${event.parentMessageId} in #${event.channelName}`
          : `mention in thread ${event.parentMessageId}`;
      }

      return event.channelName ? `mention in #${event.channelName}` : 'mention';
    case SquadNotificationType.Thread:
      return event.channelName
        ? `thread reply in #${event.channelName}`
        : event.parentMessageId
          ? `thread reply to ${event.parentMessageId}`
          : 'thread reply';
    default:
      return 'squad event';
  }
}

function formatQueuedSessionEventAction(
  event: SquadQueuedSessionEvent
): string {
  switch (event.type) {
    case SquadNotificationType.DM:
      return `Use squad-board to read DMs with ${event.fromAgentId} and reply if needed.`;
    case SquadNotificationType.Mention:
      if (event.parentMessageId) {
        return `Use squad-board to read thread ${event.parentMessageId} and respond if needed.`;
      }

      return event.channelName
        ? `Use squad-board to read #${event.channelName} and respond if needed.`
        : 'Use squad-board to inspect the mention context and respond if needed.';
    case SquadNotificationType.Thread:
      return event.parentMessageId
        ? `Use squad-board to read thread ${event.parentMessageId} and reply if needed.`
        : 'Use squad-board to inspect the thread context and reply if needed.';
    default:
      return 'Use squad-board to inspect the latest squad context.';
  }
}

function formatQueuedSessionEventMessage(
  event: SquadQueuedSessionEvent
): string {
  return `<system-reminder>
Squad wake-up
Type: ${formatQueuedSessionEventType(event.type)}
From: ${event.fromAgentId}
To: ${event.targetAgentId}
Context: ${formatQueuedSessionEventContext(event)}
Message:
${event.content}

This event is also queued in the squad-board notification feed.
${formatQueuedSessionEventAction(event)}
</system-reminder>`;
}

async function injectQueuedSessionEvent(
  event: SquadQueuedSessionEvent
): Promise<void> {
  const state = await getSquadState(event.squadId);
  const targetAgent = state?.agents.find(
    (agent) => agent.agentId === event.targetAgentId
  );

  if (!targetAgent?.sessionId) {
    return;
  }

  try {
    await getTuiDaemonAdapter().addUserMessage({
      sessionId: targetAgent.sessionId,
      text: formatQueuedSessionEventMessage(event),
    });
  } catch (error) {
    logWarn('[SquadBoardStore] Failed to inject queued squad session message', {
      cause: error,
      teamId: event.squadId,
      droolId: event.targetAgentId,
      sessionId: targetAgent.sessionId,
      type: event.type,
    });
  }
}

async function queueAndInjectNotification(params: {
  squadId: string;
  agentId: string;
  notification: SquadBoardNotification;
  event: SquadQueuedSessionEvent;
}): Promise<void> {
  await queueNotification({
    squadId: params.squadId,
    agentId: params.agentId,
    notification: params.notification,
  });
  await injectQueuedSessionEvent(params.event);
}

async function notifyMentions(params: {
  squadId: string;
  callerAgentId: string;
  messageId: string;
  content: string;
  channelName?: string;
  parentMessageId?: string;
}): Promise<void> {
  const mentionedAgents = parseMentions(params.content);
  await Promise.all(
    mentionedAgents
      .filter((agentId) => agentId !== params.callerAgentId)
      .map(async (agentId) => {
        await queueAndInjectNotification({
          squadId: params.squadId,
          agentId,
          notification: createNotification({
            type: SquadNotificationType.Mention,
            fromAgentId: params.callerAgentId,
            messageId: params.messageId,
            channelName: params.channelName,
            parentMessageId: params.parentMessageId,
          }),
          event: {
            squadId: params.squadId,
            targetAgentId: agentId,
            type: SquadNotificationType.Mention,
            fromAgentId: params.callerAgentId,
            content: params.content,
            channelName: params.channelName,
            parentMessageId: params.parentMessageId,
          },
        });
      })
  );
}

async function getAgentNames(squadId: string): Promise<Map<string, string>> {
  const state = await getSquadState(squadId);
  return new Map([
    [SQUAD_USER_PARTICIPANT_ID, SQUAD_USER_PARTICIPANT_LABEL] as const,
    ...((state?.agents ?? []).map((agent) => [agent.agentId, agent.name]) as [
      string,
      string,
    ][]),
  ]);
}

async function getOrchestratorAgent(squadId: string) {
  const state = await getSquadState(squadId);
  return (
    state?.agents.find((agent) => agent.role === SquadRole.Orchestrator) ?? null
  );
}

async function updateAgentActivity(params: {
  squadId: string;
  authorAgentId: string;
  timestamp: string;
  introduced?: boolean;
}): Promise<void> {
  await recordAgentActivity({
    squadId: params.squadId,
    agentId: params.authorAgentId,
    timestamp: params.timestamp,
    introduced: params.introduced,
  });
}

async function locateMessage(params: {
  squadId: string;
  messageId: string;
}): Promise<
  | {
      kind: 'channel';
      locationId: string;
      parent: SquadBoardMessage;
      messages: SquadBoardMessage[];
    }
  | {
      kind: 'dm';
      locationId: string;
      parent: SquadBoardMessage;
      messages: SquadBoardMessage[];
    }
  | null
> {
  const channelDir = getSquadChannelsDir(params.squadId);
  const dmDir = getSquadDmsDir(params.squadId);

  const channelFiles = await fs.readdir(channelDir).catch(() => []);
  for (const file of channelFiles) {
    const locationId = file.replace(/\.jsonl$/, '');
    const messages = await readJsonLines<SquadBoardMessage>(
      path.join(channelDir, file)
    );
    const parent = messages.find((message) => message.id === params.messageId);
    if (parent) {
      return { kind: 'channel', locationId, parent, messages };
    }
  }

  const dmFiles = await fs.readdir(dmDir).catch(() => []);
  for (const file of dmFiles) {
    const locationId = file.replace(/\.jsonl$/, '');
    const messages = await readJsonLines<SquadBoardMessage>(
      path.join(dmDir, file)
    );
    const parent = messages.find((message) => message.id === params.messageId);
    if (parent) {
      return { kind: 'dm', locationId, parent, messages };
    }
  }

  return null;
}

async function getThreadParticipants(params: {
  parent: SquadBoardMessage;
  messages: SquadBoardMessage[];
}): Promise<string[]> {
  const participants = new Set<string>([params.parent.authorAgentId]);
  for (const message of params.messages) {
    if (message.parentMessageId === params.parent.id) {
      participants.add(message.authorAgentId);
    }
  }
  return Array.from(participants);
}

export async function createSquadChannel(params: {
  squadId: string;
  channelName: string;
}): Promise<string> {
  await ensureFile(getChannelPath(params.squadId, params.channelName));
  return `Created channel #${params.channelName}.`;
}

export async function listSquadChannels(squadId: string): Promise<string> {
  const channels = await fs
    .readdir(getSquadChannelsDir(squadId))
    .catch(() => [] as string[]);
  const names = channels
    .map((channel) => channel.replace(/\.jsonl$/, ''))
    .sort();
  if (names.length === 0) {
    return 'No channels found.';
  }

  return names.map((name) => `#${name}`).join('\n');
}

export async function postSquadChannelMessage(params: {
  squadId: string;
  channelName: string;
  callerAgentId: string;
  content: string;
}): Promise<string> {
  const message = createMessage({
    authorAgentId: params.callerAgentId,
    content: params.content,
  });
  await appendJsonLine(
    getChannelPath(params.squadId, params.channelName),
    message
  );
  await updateAgentActivity({
    squadId: params.squadId,
    authorAgentId: params.callerAgentId,
    timestamp: message.timestamp,
    introduced: params.channelName === SQUAD_GENERAL_CHANNEL,
  });
  await notifyMentions({
    squadId: params.squadId,
    callerAgentId: params.callerAgentId,
    messageId: message.id,
    content: params.content,
    channelName: params.channelName,
  });
  return `Posted to #${params.channelName}.`;
}

export async function readSquadChannel(params: {
  squadId: string;
  channelName: string;
}): Promise<string> {
  const messages = await readJsonLines<SquadBoardMessage>(
    getChannelPath(params.squadId, params.channelName)
  );
  if (messages.length === 0) {
    return `#${params.channelName} is empty.`;
  }

  const agentNames = await getAgentNames(params.squadId);
  return messages
    .map((message) => formatMessage(message, agentNames))
    .join('\n');
}

export async function sendSquadDm(params: {
  squadId: string;
  callerAgentId: string;
  targetAgentId: string;
  content: string;
}): Promise<string> {
  const message = createMessage({
    authorAgentId: params.callerAgentId,
    content: params.content,
  });
  await appendJsonLine(
    getDmPath(params.squadId, params.callerAgentId, params.targetAgentId),
    message
  );
  await updateAgentActivity({
    squadId: params.squadId,
    authorAgentId: params.callerAgentId,
    timestamp: message.timestamp,
  });
  await queueNotification({
    squadId: params.squadId,
    agentId: params.targetAgentId,
    notification: createNotification({
      type: SquadNotificationType.DM,
      fromAgentId: params.callerAgentId,
      messageId: message.id,
    }),
  });
  await injectQueuedSessionEvent({
    squadId: params.squadId,
    targetAgentId: params.targetAgentId,
    type: SquadNotificationType.DM,
    fromAgentId: params.callerAgentId,
    content: params.content,
  });
  return `Sent DM to ${params.targetAgentId}.`;
}

export async function sendUserDmToOrchestrator(params: {
  squadId: string;
  content: string;
}): Promise<string> {
  const orchestrator = await getOrchestratorAgent(params.squadId);
  if (!orchestrator) {
    return 'Orchestrator was not found.';
  }

  const message = createMessage({
    authorAgentId: SQUAD_USER_PARTICIPANT_ID,
    content: params.content,
  });
  await appendJsonLine(
    getDmPath(params.squadId, SQUAD_USER_PARTICIPANT_ID, orchestrator.agentId),
    message
  );
  await queueNotification({
    squadId: params.squadId,
    agentId: orchestrator.agentId,
    notification: createNotification({
      type: SquadNotificationType.DM,
      fromAgentId: SQUAD_USER_PARTICIPANT_ID,
      messageId: message.id,
    }),
  });
  await injectQueuedSessionEvent({
    squadId: params.squadId,
    targetAgentId: orchestrator.agentId,
    type: SquadNotificationType.DM,
    fromAgentId: SQUAD_USER_PARTICIPANT_ID,
    content: params.content,
  });

  return `Sent DM to ${orchestrator.agentId}.`;
}

export async function readSquadDms(params: {
  squadId: string;
  callerAgentId: string;
  targetAgentId: string;
}): Promise<string> {
  const messages = await readJsonLines<SquadBoardMessage>(
    getDmPath(params.squadId, params.callerAgentId, params.targetAgentId)
  );
  if (messages.length === 0) {
    return `No DMs with ${params.targetAgentId}.`;
  }

  const agentNames = await getAgentNames(params.squadId);
  return formatThreadAwareMessages(messages, agentNames);
}

export async function listSquadDmConversations(params: {
  squadId: string;
  callerAgentId: string;
}): Promise<string> {
  const files = await fs
    .readdir(getSquadDmsDir(params.squadId))
    .catch(() => []);
  const lines: string[] = [];

  for (const file of files.sort()) {
    const participants = file.replace(/\.jsonl$/, '').split('__');
    if (!participants.includes(params.callerAgentId)) {
      continue;
    }

    const targetAgentId = participants.find(
      (participant) => participant !== params.callerAgentId
    );
    if (!targetAgentId) {
      continue;
    }

    const messages = await readJsonLines<SquadBoardMessage>(
      path.join(getSquadDmsDir(params.squadId), file)
    );
    const latest = messages[messages.length - 1];
    lines.push(
      `${targetAgentId} (${messages.length} messages)${
        latest ? ` — ${formatLatestConversationSummary(latest)}` : ''
      }`
    );
  }

  if (lines.length === 0) {
    return 'No DM conversations found.';
  }

  return lines.join('\n');
}

export async function replySquadThread(params: {
  squadId: string;
  callerAgentId: string;
  parentMessageId: string;
  content: string;
}): Promise<string> {
  const location = await locateMessage({
    squadId: params.squadId,
    messageId: params.parentMessageId,
  });
  if (!location) {
    return `Parent message ${params.parentMessageId} was not found.`;
  }

  const reply = createMessage({
    authorAgentId: params.callerAgentId,
    content: params.content,
    parentMessageId: params.parentMessageId,
  });

  const filePath =
    location.kind === 'channel'
      ? getChannelPath(params.squadId, location.locationId)
      : path.join(
          getSquadDmsDir(params.squadId),
          `${location.locationId}.jsonl`
        );
  await appendJsonLine(filePath, reply);
  await updateAgentActivity({
    squadId: params.squadId,
    authorAgentId: params.callerAgentId,
    timestamp: reply.timestamp,
  });

  const participants = await getThreadParticipants({
    parent: location.parent,
    messages: location.messages,
  });
  const channelName =
    location.kind === 'channel' ? location.locationId : undefined;
  const deliveries = new Map<
    string,
    {
      notification: SquadBoardNotification;
      event: SquadQueuedSessionEvent;
    }
  >();

  for (const participant of participants) {
    if (participant === params.callerAgentId) {
      continue;
    }

    deliveries.set(participant, {
      notification: createNotification({
        type: SquadNotificationType.Thread,
        fromAgentId: params.callerAgentId,
        messageId: reply.id,
        channelName,
        parentMessageId: params.parentMessageId,
      }),
      event: {
        squadId: params.squadId,
        targetAgentId: participant,
        type: SquadNotificationType.Thread,
        fromAgentId: params.callerAgentId,
        content: params.content,
        channelName,
        parentMessageId: params.parentMessageId,
      },
    });
  }

  for (const mentionedAgentId of parseMentions(params.content)) {
    if (
      mentionedAgentId === params.callerAgentId ||
      deliveries.has(mentionedAgentId)
    ) {
      continue;
    }

    deliveries.set(mentionedAgentId, {
      notification: createNotification({
        type: SquadNotificationType.Mention,
        fromAgentId: params.callerAgentId,
        messageId: reply.id,
        channelName,
        parentMessageId: params.parentMessageId,
      }),
      event: {
        squadId: params.squadId,
        targetAgentId: mentionedAgentId,
        type: SquadNotificationType.Mention,
        fromAgentId: params.callerAgentId,
        content: params.content,
        channelName,
        parentMessageId: params.parentMessageId,
      },
    });
  }

  await Promise.all(
    Array.from(deliveries.entries()).map(async ([agentId, delivery]) => {
      await queueAndInjectNotification({
        squadId: params.squadId,
        agentId,
        notification: delivery.notification,
        event: delivery.event,
      });
    })
  );

  return 'Replied in thread.';
}

export async function readSquadThread(params: {
  squadId: string;
  parentMessageId: string;
}): Promise<string> {
  const location = await locateMessage({
    squadId: params.squadId,
    messageId: params.parentMessageId,
  });
  if (!location) {
    return `Thread root ${params.parentMessageId} was not found.`;
  }

  const agentNames = await getAgentNames(params.squadId);
  const replies = location.messages.filter(
    (message) => message.parentMessageId === params.parentMessageId
  );
  const lines = [formatMessage(location.parent, agentNames)];
  for (const reply of replies) {
    lines.push(`  ↳ ${formatMessage(reply, agentNames)}`);
  }
  return lines.join('\n');
}

export async function readSquadNotifications(params: {
  squadId: string;
  callerAgentId: string;
}): Promise<SquadBoardNotification[]> {
  return readJsonLines<SquadBoardNotification>(
    getNotificationPath(params.squadId, params.callerAgentId)
  );
}

async function readAndConsumeSquadNotifications(params: {
  squadId: string;
  callerAgentId: string;
}): Promise<SquadBoardNotification[]> {
  const notifications = await readSquadNotifications(params);
  await overwriteJsonLines(
    getNotificationPath(params.squadId, params.callerAgentId),
    []
  );
  return notifications;
}

function formatNotification(notification: SquadBoardNotification): string {
  const from = formatParticipantLabel(notification.fromAgentId);

  switch (notification.type) {
    case SquadNotificationType.DM:
      return `dm from ${from}`;
    case SquadNotificationType.Mention:
      if (notification.parentMessageId) {
        return notification.channelName
          ? `mention from ${from} in thread ${notification.parentMessageId} in #${notification.channelName}`
          : `mention from ${from} in thread ${notification.parentMessageId}`;
      }

      return notification.channelName
        ? `mention from ${from} in #${notification.channelName}`
        : `mention from ${from}`;
    case SquadNotificationType.Thread:
      if (notification.parentMessageId) {
        return notification.channelName
          ? `thread reply from ${from} in #${notification.channelName} on ${notification.parentMessageId}`
          : `thread reply from ${from} on ${notification.parentMessageId}`;
      }

      return notification.channelName
        ? `thread reply from ${from} in #${notification.channelName}`
        : `thread reply from ${from}`;
    default:
      return `${notification.type} from ${from}`;
  }
}

export async function formatSquadNotifications(params: {
  squadId: string;
  callerAgentId: string;
}): Promise<string> {
  const notifications = await readAndConsumeSquadNotifications(params);
  if (notifications.length === 0) {
    return 'No pending notifications.';
  }
  return notifications.map(formatNotification).join('\n');
}

export async function waitForSquadNotification(params: {
  squadId: string;
  callerAgentId: string;
  timeoutSeconds?: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const timeoutSeconds = params.timeoutSeconds ?? SQUAD_WAIT_TIMEOUT_SECONDS;
  const timeoutMs = Math.max(0, timeoutSeconds * 1000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (params.abortSignal?.aborted) {
      return 'Wait for notification was cancelled.';
    }

    const notifications = await readSquadNotifications({
      squadId: params.squadId,
      callerAgentId: params.callerAgentId,
    });
    if (notifications.length > 0) {
      await overwriteJsonLines(
        getNotificationPath(params.squadId, params.callerAgentId),
        []
      );
      return notifications.map(formatNotification).join('\n');
    }

    if (Date.now() >= deadline) {
      return `No notifications arrived within ${timeoutSeconds} seconds.`;
    }

    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(
        resolve,
        SQUAD_NOTIFICATION_POLL_INTERVAL_MS
      );
      params.abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        { once: true }
      );
    });
  }
}

export async function loadSquadBoardSnapshot(
  squadId: string
): Promise<SquadBoardSnapshot | null> {
  const squad = await getSquadState(squadId);
  if (!squad) {
    return null;
  }

  const channels = await fs
    .readdir(getSquadChannelsDir(squadId))
    .catch(() => []);
  const channelSnapshots = await Promise.all(
    channels.sort().map(async (file) => ({
      name: file.replace(/\.jsonl$/, ''),
      messages: await readJsonLines<SquadBoardMessage>(
        path.join(getSquadChannelsDir(squadId), file)
      ),
    }))
  );

  const dmFiles = await fs.readdir(getSquadDmsDir(squadId)).catch(() => []);
  const dmConversations = (
    await Promise.all(
      dmFiles.sort().map(async (file) => {
        const participants = file.replace(/\.jsonl$/, '').split('__');
        const messages = await readJsonLines<SquadBoardMessage>(
          path.join(getSquadDmsDir(squadId), file)
        );
        if (messages.length === 0) {
          return null;
        }

        return {
          targetAgentId: participants.join(' ↔ '),
          messages,
        } satisfies SquadDmConversationSnapshot;
      })
    )
  ).flatMap((value) => (value ? [value] : []));

  const notificationsByAgent = Object.fromEntries(
    await Promise.all(
      squad.agents.map(async (agent) => [
        agent.agentId,
        await readJsonLines<SquadBoardNotification>(
          getNotificationPath(squadId, agent.agentId)
        ),
      ])
    )
  );

  const threadReplies: Record<string, SquadBoardMessage[]> = {};
  for (const channel of channelSnapshots) {
    for (const message of channel.messages) {
      if (!message.parentMessageId) {
        continue;
      }
      threadReplies[message.parentMessageId] = [
        ...(threadReplies[message.parentMessageId] ?? []),
        message,
      ];
    }
  }

  return {
    squad,
    channels: channelSnapshots,
    dmConversations,
    threadReplies,
    notificationsByAgent,
  };
}
