export const PENDING_UPDATE_MARKER_FILENAME = 'pending-update.json';

/** Max number of failed attempts before abandoning a pending Windows update */
export const MAX_PENDING_UPDATE_ATTEMPTS = 3;

/** Max age (in ms) for a pending update marker before it's considered stale (7 days) */
export const MAX_PENDING_UPDATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
