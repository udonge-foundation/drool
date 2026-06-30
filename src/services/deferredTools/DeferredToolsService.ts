/**
 * Session-scoped service tracking which deferred tools have been "loaded"
 * via ToolSearch. Once loaded, a tool stays available for the rest of the session.
 */
export class DeferredToolsService {
  private loadedBySessionId = new Map<string, Set<string>>();

  markLoaded(sessionId: string | null | undefined, name: string): void {
    this.getOrCreateLoadedSet(sessionId).add(name);
  }

  markLoadedBatch(sessionId: string | null | undefined, names: string[]): void {
    const loaded = this.getOrCreateLoadedSet(sessionId);
    for (const name of names) {
      loaded.add(name);
    }
  }

  isLoaded(sessionId: string | null | undefined, name: string): boolean {
    return this.getLoaded(sessionId).has(name);
  }

  getLoaded(sessionId: string | null | undefined): ReadonlySet<string> {
    return (
      this.loadedBySessionId.get(this.getSessionKey(sessionId)) ??
      DeferredToolsService.EMPTY_LOADED_SET
    );
  }

  resetSession(sessionId: string | null | undefined): void {
    this.loadedBySessionId.delete(this.getSessionKey(sessionId));
  }

  reset(): void {
    this.loadedBySessionId.clear();
  }

  private getOrCreateLoadedSet(
    sessionId: string | null | undefined
  ): Set<string> {
    const sessionKey = this.getSessionKey(sessionId);
    const existing = this.loadedBySessionId.get(sessionKey);
    if (existing) {
      return existing;
    }

    const loaded = new Set<string>();
    this.loadedBySessionId.set(sessionKey, loaded);
    return loaded;
  }

  private getSessionKey(sessionId: string | null | undefined): string {
    return sessionId ?? DeferredToolsService.FALLBACK_SESSION_KEY;
  }

  private static readonly FALLBACK_SESSION_KEY = '__no_session__';

  private static readonly EMPTY_LOADED_SET = new Set<string>();
}

let instance: DeferredToolsService | null = null;

export function getDeferredToolsService(): DeferredToolsService {
  if (!instance) {
    instance = new DeferredToolsService();
  }
  return instance;
}
