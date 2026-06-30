export const START_MISSION_RUN_PROGRESS_KIND =
  'start_mission_run_snapshot' as const;

/**
 * Default maximum number of worker attempts allowed per feature. A feature
 * accrues one entry in `workerSessionIds` each time a worker is spawned for it.
 * Once a feature reaches its effective cap, the mission is paused (rather than
 * looping forever) so a perpetually-failing feature can't burn workers in a
 * retry loop. The user can resume to grant the feature a fresh attempt budget.
 */
export const MAX_FEATURE_ATTEMPTS = 5;
