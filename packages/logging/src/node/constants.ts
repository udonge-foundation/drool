/**
 * Default size cap (bytes) for a single log fragment. When the active
 * log file crosses this threshold within a day it is rotated to a new
 * within-day fragment so a single chatty session cannot starve out the
 * rest of the day's history.
 */
export const DEFAULT_MAX_LOG_FRAGMENT_BYTES = 100 * 1024 * 1024;
/**
 * Default number of distinct days of logs to retain. Set high enough
 * that a developer can grep last month's history when debugging a
 * regression that took a while to surface. Count-based rather than
 * calendar-age-based: see `LogRotationOptions.maxDays`.
 */
export const DEFAULT_MAX_LOG_DAYS = 30;
/**
 * Default cap on the total bytes of log files retained on disk
 * (active + all archives). When exceeded, cleanup drops the oldest
 * day's archives in full so the on-disk history never has gaps within
 * a day.
 */
export const DEFAULT_MAX_TOTAL_LOG_BYTES = 1024 * 1024 * 1024;
