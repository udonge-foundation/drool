import { useMemo } from 'react';

import { useMissionStoreSnapshot } from '@industry/daemon-client/session';

import type {
  MissionData,
  MissionLoadError,
} from '@/components/mission-control/types';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getSessionService } from '@/services/SessionService';

import type { MissionSnapshot } from '@industry/drool-sdk-ext/protocol/drool';

interface UseMissionSnapshotResult {
  loading: boolean;
  error: MissionLoadError | null;
  data: MissionData | null;
}

const EMPTY_SNAPSHOT: MissionSnapshot = {
  state: 'awaiting_input' as MissionSnapshot['state'],
  features: [],
  progressLog: [],
  workerSessionIds: [],
};

function getTuiMissionStore(missionSessionId: string) {
  return getTuiDaemonAdapter()
    .getMissionStateManager()
    .getMissionStore(missionSessionId);
}

export function useMissionSnapshot(): UseMissionSnapshotResult {
  const missionSessionId = getSessionService().getCurrentSessionId();

  const snapshot = useMissionStoreSnapshot({
    sessionId: missionSessionId,
    getMissionStore: getTuiMissionStore,
    fallbackSnapshot: EMPTY_SNAPSHOT,
  });

  const error: MissionLoadError | null = useMemo(() => {
    if (missionSessionId) {
      return null;
    }

    return {
      type: 'not_found',
      message: getI18n().t('common:missionData.noActiveSession'),
    };
  }, [missionSessionId]);

  const data: MissionData | null = useMemo(() => {
    if (!missionSessionId || snapshot === EMPTY_SNAPSHOT) {
      return null;
    }

    return {
      missionDir: getMissionFileService(missionSessionId).getMissionDir(),
      workingDirectory:
        getSessionService().getCurrentSessionCwd() ?? process.cwd(),
      snapshot,
    };
  }, [missionSessionId, snapshot]);

  return { loading: false, error, data };
}
