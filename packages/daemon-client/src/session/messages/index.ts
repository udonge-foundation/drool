/**
 * SSM-backed React hooks for consuming session state from the
 * `MultiSessionStateManager`. The frontend (web/desktop) uses these to render
 * chat surfaces over `IndustryDroolMessage[]`; the CLI runs its own
 * derivation pipeline over the same SSM and does not depend on this module.
 */

export { useSessionDisplayMessages } from './useSessionDisplayMessages';
export { useSessionWorkingState } from './useSessionWorkingState';
export { useSessionQueuedMessages } from './useSessionQueuedMessages';
export { useSessionStreamingPlaceholder } from './useSessionStreamingPlaceholder';
export { useSessionTodoList } from './useSessionTodoList';
export { useSessionLoadState } from './useSessionLoadState';
export { useSessionTags, useSessionTagSnapshots } from './useSessionTags';
export type { SessionTagsSnapshot } from '../types';
export type { SessionTodoItem, SessionTodoList } from '../state/types';
