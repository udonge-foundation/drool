import { AutomationRunStatus } from '@industry/common/api/v0/automations';
import { AutomationRunType } from '@industry/common/automations';
import { SESSION_TAG_AUTOMATION } from '@industry/common/session';
import { discoverAllAutomations } from '@industry/drool-core/automations';

import type { GetPersistedLocalAutomationHistoryOptions } from './types';
import type { SessionIndexEntry } from '../server/handlers/types';
import type { AutomationRunRecord } from '@industry/common/automations';

export async function getPersistedLocalAutomationHistory({
  automationId,
  basePath,
  limit = 50,
  offset = 0,
}: GetPersistedLocalAutomationHistoryOptions): Promise<{
  runs: AutomationRunRecord[];
  totalCount: number;
}> {
  const { sessionIndexCache } = await import(
    '../server/handlers/session-index-cache'
  );
  const discovery = await discoverAllAutomations(basePath);
  const automation = discovery.automations.find(
    (entry) => entry.id === automationId || entry.config?.id === automationId
  );
  // Prefer the automation's stable UUID over the directory slug. The slug is
  // derived purely from the name (buildAutomationSlug) and is reused when an
  // automation is deleted and a new one is created with the same name, so slug
  // matching makes the new automation inherit the deleted one's sessions. When a
  // UUID is available we match it exclusively; we only fall back to slug
  // matching for legacy automations/sessions that were never tagged with one.
  const automationUuid = automation?.config?.id;
  const slugIds = new Set([automationId]);
  if (automation) slugIds.add(automation.id);

  const matched = (await sessionIndexCache.getAll())
    .map((session) => {
      const automationTag = session.tags?.find((tag) => {
        if (tag.name !== SESSION_TAG_AUTOMATION) return false;
        if (automationUuid) {
          return String(tag.metadata?.automationUuid ?? '') === automationUuid;
        }
        return slugIds.has(String(tag.metadata?.automationId ?? ''));
      });
      if (!automationTag) return undefined;
      const type: AutomationRunType =
        automationTag.metadata?.type === AutomationRunType.Create
          ? AutomationRunType.Create
          : AutomationRunType.Run;
      return { session, type };
    })
    .filter(
      (
        entry
      ): entry is { session: SessionIndexEntry; type: AutomationRunType } =>
        entry !== undefined
    )
    .sort((left, right) => right.session.mtime - left.session.mtime);

  return {
    runs: matched.slice(offset, offset + limit).map(({ session, type }) => ({
      runId: session.sessionId,
      sessionId: session.sessionId,
      automationId,
      type,
      status: AutomationRunStatus.Success,
      startedAt: new Date(session.mtime).toISOString(),
    })),
    totalCount: matched.length,
  };
}
