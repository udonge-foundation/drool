import path from 'path';

import { BugReportUploadResponse } from '@industry/common/api/backend/types';
import { logInfo, logException, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getAuthedUser } from '@industry/runtime/auth';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getAuthHeadersOrThrow } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import {
  createZipBuffer,
  getBugReportRelatedSessions,
  resolveSquadStateForBugReport,
} from '@/commands/bug';
import type { SubmitBugReportResult } from '@/commands/bug/types';
import { getRuntimeAuthConfig } from '@/environment';
import { isMissionOrchestratorSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';

const MAX_ZIP_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB
const INDUSTRY_INTERNAL_ORG_IDS = new Set([
  '8Gwsui069uJX17GEIpGM', // prod
  'Mh4w1YIyEvZ3FHQ5WeKn', // dev
]);

export async function submitBugReport(
  userComment: string,
  clientLogs?: string
): Promise<SubmitBugReportResult> {
  const sessionService = getSessionService();
  const currentSessionId = sessionService.getCurrentSessionId();

  if (!currentSessionId) {
    throw new MetaError('No active session found');
  }

  const sessionFilePath = sessionService.getSessionTranscriptPath();
  const sessionSettingsPath = sessionService.getCurrentSessionSettingsPath();

  if (!sessionFilePath) {
    throw new MetaError('Session file not found');
  }

  const { missionId, relatedSessions } = await getBugReportRelatedSessions(
    currentSessionId,
    sessionFilePath,
    sessionSettingsPath
  );

  const industryHome = getIndustryHome();
  const logsDir = path.join(industryHome, getIndustryDirName(), 'logs');
  const droolLogPath = path.join(logsDir, 'drool-log-single.log');
  const consoleLogPath = path.join(logsDir, 'console.log');
  const industrydLogPath =
    missionId ||
    isMissionOrchestratorSession(sessionService.getCurrentSessionTags())
      ? path.join(logsDir, 'industryd.log')
      : undefined;

  const user = await getAuthedUser(getRuntimeAuthConfig());
  const isInternalOrg = INDUSTRY_INTERNAL_ORG_IDS.has(user?.orgId ?? '');

  // Resolve squad state if available
  const squadState = await resolveSquadStateForBugReport();

  // Flush buffered logs to disk so the bug report captures everything
  try {
    await CliTelemetryClient.getInstance().forceFlush();
  } catch (error) {
    logException(error, '[bug] Failed to flush logs before bug report');
  }

  const zipBuffer = await createZipBuffer(
    currentSessionId,
    sessionFilePath,
    sessionSettingsPath,
    droolLogPath,
    consoleLogPath,
    industrydLogPath,
    userComment,
    isInternalOrg,
    clientLogs,
    squadState,
    relatedSessions,
    missionId
  );

  logInfo('[bug] Created zip buffer (standalone submit)', {
    sizeBytes: zipBuffer.length,
    sizeMb: Number((zipBuffer.length / (1024 * 1024)).toFixed(2)),
  });

  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    logWarn('[bug] Bug report exceeds size limit', {
      sizeBytes: zipBuffer.length,
      maxSizeMb: MAX_ZIP_SIZE_BYTES / (1024 * 1024),
    });
    throw new MetaError('Bug report data is too large');
  }

  const base64Zip = zipBuffer.toString('base64');

  const requestBody = {
    zipData: base64Zip,
    metadata: {
      sessionId: currentSessionId,
      userComment,
    },
  };

  const authHeaders = await getAuthHeadersOrThrow();

  const response = await fetchBackend('/api/bug-reports', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new MetaError('Bug report upload failed', {
      value: {
        status: response.status,
        errorText,
      },
    });
  }

  const result: BugReportUploadResponse = await response.json();

  logInfo('[bug] Bug report uploaded successfully (standalone submit)', {
    bugReportId: result.bugReportId,
    sessionId: currentSessionId,
    sizeBytes: zipBuffer.length,
  });

  return { bugReportId: result.bugReportId };
}
