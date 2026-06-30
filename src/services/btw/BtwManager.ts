import { SESSION_TAG_BTW_FORK } from '@industry/common/session';
import {
  DroolWorkingState,
  SessionNotificationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo, logWarn } from '@industry/logging';

import { BtwEntryStatus } from '@/services/btw/enums';
import type { BtwEntry } from '@/services/btw/types';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

import type { DaemonSessionNotificationParams } from '@industry/common/daemon';

type Listener = () => void;

interface PendingAttribution {
  entryId: string;
  /** id of the user CREATE_MESSAGE we observe after addUserMessage */
  userMessageId: string | null;
  /** id of the assistant CREATE_MESSAGE (captured on first delta/create) */
  assistantMessageId: string | null;
  /** true once we see Working, a delta, or an assistant CREATE_MESSAGE */
  hasObservedWork: boolean;
}

const BTW_FORK_TITLE = '/btw side conversation (hidden)';

/**
 * BtwManager owns the lifecycle of a single hidden fork session used to answer
 * side questions without polluting the main session transcript.
 *
 * Lifecycle:
 *   - lazy: the fork is only created on the first /btw <question>.
 *   - fresh: each batch of questions gets a fresh fork; the fork is
 *     closed once all pending questions complete, so the next question
 *     forks from the latest main-session context.
 *   - cleanup(): drops any active fork (used on /clear, /new, session change).
 */
export class BtwManager {
  private readonly mainSessionId: string;

  private forkSessionId: string | null = null;

  private forkInitPromise: Promise<string> | null = null;

  private unsubscribeFromFork: (() => void) | null = null;

  private entries: ReadonlyArray<BtwEntry> = [];

  /**
   * Attribution queue: maps each in-flight question to the daemon
   * message ids we discover via CREATE_MESSAGE notifications. Entries
   * are removed when the fork reports Idle (after observed work) or
   * an error.
   */
  private pending: PendingAttribution[] = [];

  private listeners = new Set<Listener>();

  /**
   * Set to true by cleanup(). Observed at each async boundary in ensureFork()
   * so an in-flight fork-creation flow can self-tear-down (unsubscribe and
   * close the daemon session) if the manager was disposed mid-flight. Without
   * this, a `/btw` question racing against a session change would orphan
   * both a daemon fork session and its notification subscription.
   */
  private isDisposed = false;

  constructor(mainSessionId: string) {
    this.mainSessionId = mainSessionId;
  }

  public getMainSessionId(): string {
    return this.mainSessionId;
  }

  public getEntries(): ReadonlyArray<BtwEntry> {
    return this.entries;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public removeEntry(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    this.pending = this.pending.filter((p) => p.entryId !== id);
    const next = this.entries.slice();
    next.splice(idx, 1);
    this.entries = next;
    this.notify();
    if (this.pending.length === 0) {
      void this.teardownFork();
    }
  }

  /**
   * Submit a side question. Creates the fork lazily on first call.
   * Returns a promise that resolves when the question has been dispatched
   * (the answer streams in asynchronously via notifications).
   */
  public async submit(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }

    const entry: BtwEntry = {
      id: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question: trimmed,
      answer: '',
      status: BtwEntryStatus.Pending,
      createdAt: Date.now(),
    };
    this.entries = [...this.entries, entry];
    this.pending = [
      ...this.pending,
      {
        entryId: entry.id,
        userMessageId: null,
        assistantMessageId: null,
        hasObservedWork: false,
      },
    ];
    this.notify();

    try {
      const forkId = await this.ensureFork();
      this.updateEntry(entry.id, (e) => ({
        ...e,
        status: BtwEntryStatus.Streaming,
      }));

      const adapter = getTuiDaemonAdapter();
      await adapter.addUserMessage({
        sessionId: forkId,
        text: escapeUserMessageSystemTags(trimmed),
      });
    } catch (error) {
      logException(error, '[BtwManager] Failed to submit /btw question');
      this.updateEntry(entry.id, (e) => ({
        ...e,
        status: BtwEntryStatus.Error,
        answer:
          e.answer ||
          (error instanceof Error ? error.message : 'Failed to ask question'),
      }));
      this.pending = this.pending.filter((p) => p.entryId !== entry.id);
    }
  }

  /**
   * Dispose of the hidden fork (closes daemon session, unsubscribes handlers).
   * Does NOT delete the fork's JSONL (the caller in SessionService already
   * tagged it btw-fork so it's hidden from all listings).
   *
   * Safe to call while an ensureFork() IIFE is still in flight: the flag is
   * set first, then we await the in-flight promise so its self-teardown
   * (which runs at the next await boundary) can finish before cleanup
   * returns.
   */
  public async cleanup(): Promise<void> {
    this.isDisposed = true;
    this.listeners.clear();
    this.entries = [];
    this.pending = [];

    // Wait for any in-flight fork-creation to observe isDisposed and
    // self-tear-down. We swallow rejection because that is the expected
    // signal that the IIFE saw disposal and aborted.
    const pendingInit = this.forkInitPromise;
    if (pendingInit) {
      try {
        await pendingInit;
      } catch {
        // Expected when the IIFE aborts on disposal.
      }
    }

    await this.teardownFork();
  }

  // ── internals ──

  /**
   * Tear down the current fork: unsubscribe from notifications, close the
   * daemon session, and reset fork state so the next question creates a
   * fresh fork from the latest main-session context.
   */
  private async teardownFork(): Promise<void> {
    if (this.unsubscribeFromFork) {
      this.unsubscribeFromFork();
      this.unsubscribeFromFork = null;
    }
    const forkId = this.forkSessionId;
    this.forkSessionId = null;
    this.forkInitPromise = null;
    if (forkId) {
      try {
        await getTuiDaemonAdapter().closeSession(forkId);
      } catch (error) {
        logWarn('[BtwManager] Failed to close btw fork session', {
          cause: error,
          sessionId: forkId,
        });
      }
    }
  }

  private async ensureFork(): Promise<string> {
    if (this.isDisposed) {
      throw new Error('BtwManager disposed');
    }
    if (this.forkSessionId) {
      return this.forkSessionId;
    }
    if (this.forkInitPromise) {
      return this.forkInitPromise;
    }
    this.forkInitPromise = (async () => {
      const sessionService = getSessionService();
      logInfo('[BtwManager] Creating hidden /btw fork', {
        sessionId: this.mainSessionId,
      });
      const newForkId = await sessionService.forkSession(
        this.mainSessionId,
        null,
        BTW_FORK_TITLE,
        this.mainSessionId,
        'btw',
        {
          skipRemoteCreation: true,
          preserveCurrentSession: true,
          useBtwDirectory: true,
          extraTags: [{ name: SESSION_TAG_BTW_FORK }],
        }
      );
      // Disposal checkpoint: the fork JSONL now exists on disk but nothing
      // daemon-side has been created yet. The file is already tagged as a
      // btw-fork, so it is hidden from session listings; abort without
      // further cleanup.
      if (this.isDisposed) {
        throw new Error('BtwManager disposed before loadSession');
      }
      const adapter = getTuiDaemonAdapter();
      // Load the fork session in the daemon so it gets its own drool process.
      await adapter.loadSession(newForkId);
      // Disposal checkpoint: the daemon now owns a live session for this
      // fork. Close it to avoid leaking a daemon-side session + drool proc.
      if (this.isDisposed) {
        try {
          await adapter.closeSession(newForkId);
        } catch (error) {
          logWarn(
            '[BtwManager] Failed to close orphaned btw fork session (post-load)',
            {
              cause: error,
              sessionId: newForkId,
            }
          );
        }
        throw new Error('BtwManager disposed after loadSession');
      }
      const unsubscribe = adapter.subscribeToSessionNotifications(
        newForkId,
        (notification) => this.handleForkNotification(notification)
      );
      // Final disposal checkpoint: if we raced a cleanup right at the end,
      // tear down both the subscription we just created and the daemon
      // session before publishing any state onto `this`.
      if (this.isDisposed) {
        try {
          unsubscribe();
        } catch {
          // Best-effort cleanup; ignore.
        }
        try {
          await adapter.closeSession(newForkId);
        } catch (error) {
          logWarn(
            '[BtwManager] Failed to close orphaned btw fork session (post-subscribe)',
            {
              cause: error,
              sessionId: newForkId,
            }
          );
        }
        throw new Error('BtwManager disposed after subscribe');
      }
      this.forkSessionId = newForkId;
      this.unsubscribeFromFork = unsubscribe;
      return newForkId;
    })();

    try {
      return await this.forkInitPromise;
    } finally {
      if (!this.forkSessionId) {
        this.forkInitPromise = null;
      }
    }
  }

  private handleForkNotification(
    notification: DaemonSessionNotificationParams['notification']
  ): void {
    if (this.pending.length === 0) return;

    switch (notification.type) {
      case SessionNotificationType.ASSISTANT_TEXT_DELTA: {
        // Route by assistant messageId when available, otherwise fall
        // back to queue head.
        const target =
          this.pending.find(
            (p) => p.assistantMessageId === notification.messageId
          ) ?? this.pending[0];
        target.hasObservedWork = true;
        this.updateEntry(target.entryId, (e) => ({
          ...e,
          answer: e.answer + notification.textDelta,
          status:
            e.status !== BtwEntryStatus.Streaming
              ? BtwEntryStatus.Streaming
              : e.status,
        }));
        break;
      }
      case SessionNotificationType.CREATE_MESSAGE: {
        const msg = notification.message;
        if (msg.role === MessageRole.User) {
          // Bind this user message id to the oldest entry still awaiting one.
          const target = this.pending.find((p) => p.userMessageId === null);
          if (target) {
            target.userMessageId = msg.id;
          }
          break;
        }
        if (msg.role === MessageRole.Assistant) {
          // Route via parentId → userMessageId when present, otherwise
          // bind to the oldest unbound assistant slot.
          const parent = msg.parentId ?? null;
          const target =
            (parent
              ? this.pending.find((p) => p.userMessageId === parent)
              : null) ??
            this.pending.find((p) => p.assistantMessageId === null);
          if (!target) break;
          target.assistantMessageId = msg.id;
          target.hasObservedWork = true;
          if (Array.isArray(msg.content)) {
            const text = msg.content
              .filter(
                (
                  b
                ): b is { type: MessageContentBlockType.Text; text: string } =>
                  (b as { type: string }).type === MessageContentBlockType.Text
              )
              .map((b) => b.text)
              .join('');
            if (text) {
              this.updateEntry(target.entryId, (e) =>
                text.length > e.answer.length ? { ...e, answer: text } : e
              );
            }
          }
        }
        break;
      }
      case SessionNotificationType.DROOL_WORKING_STATE_CHANGED: {
        if (notification.newState !== DroolWorkingState.Idle) {
          // Any non-Idle state (Thinking, StreamingAssistantMessage,
          // ExecutingTool, etc.) counts as observed work for the head
          // entry so a subsequent Idle is treated as its completion.
          const head = this.pending[0];
          if (head) head.hasObservedWork = true;
          break;
        }
        // Only complete an entry that has actually been worked on.
        const target = this.pending.find((p) => p.hasObservedWork);
        if (!target) break;
        const current = this.entries.find((e) => e.id === target.entryId);
        if (
          current &&
          (current.status === BtwEntryStatus.Streaming ||
            current.status === BtwEntryStatus.Pending)
        ) {
          this.updateEntry(target.entryId, (e) => ({
            ...e,
            status: BtwEntryStatus.Complete,
          }));
          this.pending = this.pending.filter((p) => p !== target);
        }
        // Close the fork when all pending questions are done so the next
        // question creates a fresh fork with the latest main-session context.
        if (this.pending.length === 0) {
          void this.teardownFork();
        }
        break;
      }
      case SessionNotificationType.ERROR: {
        const target = this.pending[0];
        if (!target) break;
        this.updateEntry(target.entryId, (e) => ({
          ...e,
          status: BtwEntryStatus.Error,
          answer: e.answer || notification.message,
        }));
        this.pending = this.pending.filter((p) => p !== target);
        if (this.pending.length === 0) {
          void this.teardownFork();
        }
        break;
      }
      default:
        break;
    }
  }

  private updateEntry(
    id: string,
    updater: (entry: BtwEntry) => BtwEntry
  ): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const updated = updater(this.entries[idx]);
    if (updated === this.entries[idx]) return;
    const next = this.entries.slice();
    next[idx] = updated;
    this.entries = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logWarn('[BtwManager] Listener threw', { cause: error });
      }
    }
  }
}

// ── Singleton registry per main session ──
const managers = new Map<string, BtwManager>();

export function getBtwManager(mainSessionId: string): BtwManager {
  const existing = managers.get(mainSessionId);
  if (existing) return existing;
  const manager = new BtwManager(mainSessionId);
  managers.set(mainSessionId, manager);
  return manager;
}

export async function disposeBtwManager(mainSessionId: string): Promise<void> {
  const manager = managers.get(mainSessionId);
  if (!manager) return;
  managers.delete(mainSessionId);
  await manager.cleanup();
}
