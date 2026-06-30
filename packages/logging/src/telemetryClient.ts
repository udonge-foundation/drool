import { ClientType } from '@industry/common/shared';
import {
  INDUSTRY_CLIENT_HEADER,
  INDUSTRY_CLIENT_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import { MetaError, ResponseError } from '@industry/logging/errors';

import { LogLevel, TelemetryEventType } from './enums';
import { getGithubSha } from './loggerConfig';
import { LogMetadata } from './metadata/types';
import { MetricLabels } from './metrics/types';
import { getSentryAdapter, isSentryEnabled } from './sentry';
import { getTelemetryIngestBaseUrl } from './telemetryEnvironment';
import { TELEMETRY_INGEST_PATH } from './tracing/constants';
import { extractSessionIdFromPath } from './utils';

import type { PrivateAttributes, TelemetryEvent } from './types';

// IMPORTANT: THIS IS A LOW LEVEL CLASS. DO NOT CALL METRICS OR LOG HERE OR IT WILL RECURSIVELY CALL ITSELF FOREVER
// ONLY USE console.log() to log messages in this class
export class TelemetryClient {
  private static readonly GITHUB_SHA_TAG = 'clientVersion';

  private static events: unknown[] = [];

  private static flushTimeout: NodeJS.Timeout | null = null;

  private static isInitialized: boolean = false;

  private static isFlushInProgress: boolean = false;

  private static readonly FLUSH_INTERVAL_MS: number = 2000; // 2 seconds

  private static readonly MAX_EVENTS_PER_FLUSH: number = 100;

  private static hostname: string;

  // Optional function to get access token for authenticated telemetry requests
  private static accessTokenGetter: (() => Promise<string | null>) | null =
    null;

  private static webTelemetryDisabledGetter: (() => boolean) | null = null;

  /**
   * Set a function that returns the current access token.
   * This allows the TelemetryClient to send authenticated requests
   * so the backend can associate events with the user.
   */
  public static setAccessTokenGetter(
    getter: () => Promise<string | null>
  ): void {
    this.accessTokenGetter = getter;
  }

  /**
   * Set a function that disables browser web telemetry flushes.
   * Disk logging is Node-only, so browser callers use this to drop queued
   * events without making network requests in restricted runtimes.
   */
  public static setWebTelemetryDisabledGetter(
    getter: (() => boolean) | null
  ): void {
    this.webTelemetryDisabledGetter = getter;
  }

  private static isWebTelemetryDisabled(): boolean {
    try {
      return this.webTelemetryDisabledGetter?.() === true;
    } catch {
      return false;
    }
  }

  private static initialize(): void {
    if (this.isInitialized) {
      return;
    }

    this.isInitialized = true;

    // Add event listener for page unload to ensure events are sent
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        void this.flush();
        this.cleanup();
      });
    }
  }

  private static cleanup(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    this.isInitialized = false;
  }

  private static getGithubShaFromEvent(event: unknown): string | undefined {
    if (!event || typeof event !== 'object') {
      return undefined;
    }

    const attributes = Reflect.get(event, 'attributes');
    if (!attributes || typeof attributes !== 'object') {
      return undefined;
    }

    const tags = Reflect.get(attributes, 'tags');
    if (!tags || typeof tags !== 'object') {
      return undefined;
    }

    const candidate = Reflect.get(tags, this.GITHUB_SHA_TAG);
    if (typeof candidate !== 'string') {
      return undefined;
    }

    return candidate.trim() || undefined;
  }

  private static getGithubShaFromEvents(events: unknown[]): string | undefined {
    for (const event of events) {
      const githubSha = this.getGithubShaFromEvent(event);
      if (githubSha) {
        return githubSha;
      }
    }

    return undefined;
  }

  private static addEvent(event: TelemetryEvent): void {
    if (typeof window === 'undefined') {
      throw new MetaError(
        'TelemetryClient can only be used in the client-side environment'
      );
    }

    if (!this.isInitialized) {
      this.initialize();
    }

    const combinedAttributes: PrivateAttributes = {
      ...event.attributes,
      clientTimestampMs: Date.now(),
      clientPath: window?.location?.pathname || 'unknown',
      isClientMetric:
        event.type === TelemetryEventType.METRIC ? true : undefined,
      isClientLog: event.type === TelemetryEventType.LOG ? true : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- window.electronAPI is injected by Electron preload; no global type declaration available
      clientPlatform: (window as any)?.electronAPI ? 'desktop' : 'web',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- window.electronAPI is injected by Electron preload; no global type declaration available
    const clientType = (window as any)?.electronAPI
      ? ClientType.WebDesktop
      : ClientType.WebApp;

    const tags: Record<string, string> = {
      ...combinedAttributes.tags,
      clientType,
    };

    // eslint-disable-next-line industry/no-direct-process-env -- Browser telemetry client uses Vite build-time env vars (VITE_*)
    const environment = process.env.VITE_VERCEL_ENV;
    if (environment) {
      tags.environment = environment;
    }

    // eslint-disable-next-line industry/no-direct-process-env -- Browser telemetry client uses Vite build-time env vars (VITE_*)
    const githubSha = getGithubSha() ?? process.env.GITHUB_SHA;
    if (githubSha) {
      tags[this.GITHUB_SHA_TAG] = githubSha;
    }

    const sessionId = extractSessionIdFromPath(
      window?.location?.pathname || ''
    );
    if (sessionId) {
      tags.sessionId = sessionId;
    }

    combinedAttributes.tags = tags;

    this.events.push({
      ...event,
      attributes: combinedAttributes,
    });

    // Only schedule a flush if one isn't already scheduled
    if (!this.flushTimeout) {
      this.scheduleNextFlush();
    }
  }

  // DO NOT CALL THIS METHOD DIRECTLY, use `Metrics.*` methods instead
  public static addMetric_INTERNAL_USE_ONLY(
    name: string,
    value: number,
    labels?: MetricLabels
  ): void {
    this.addEvent({
      type: TelemetryEventType.METRIC,
      name,
      value,
      attributes: labels ?? {},
    });
  }

  // DO NOT CALL THIS METHOD DIRECTLY, use `logInfo`, `logWarn`, or `logError` instead
  public static addLog_INTERNAL_USE_ONLY(
    level: LogLevel,
    message: string,
    metadata?: LogMetadata
  ): void {
    this.addEvent({
      type: TelemetryEventType.LOG,
      level,
      message,
      attributes: metadata ?? {},
    });
  }

  /**
   * Schedule the next flush operation
   */
  private static scheduleNextFlush(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    this.flushTimeout = setTimeout(() => {
      void this.flush();
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * Flush events to the server
   * @returns Promise that resolves when the flush is complete
   */
  public static async flush(): Promise<void> {
    // Clear the timeout since we're flushing now
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.events.length === 0 || this.isFlushInProgress) {
      return;
    }

    if (this.isWebTelemetryDisabled()) {
      this.events = [];
      return;
    }

    this.isFlushInProgress = true;
    const eventsToSend = this.events.slice(0, this.MAX_EVENTS_PER_FLUSH);

    try {
      const githubSha =
        getGithubSha() ?? this.getGithubShaFromEvents(eventsToSend);

      // Build headers, optionally including auth token
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- window.electronAPI is injected by Electron preload; no global type declaration available
        [INDUSTRY_CLIENT_HEADER]: (window as any)?.electronAPI
          ? ClientType.WebDesktop
          : ClientType.WebApp,
        ...(githubSha && {
          [INDUSTRY_CLIENT_VERSION]: githubSha,
        }),
      };

      if (this.accessTokenGetter) {
        try {
          const token = await this.accessTokenGetter();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }
        } catch (error) {
          // eslint-disable-next-line no-console -- logging infra can't use log fns (recursion)
          console.warn('Failed to get auth token for telemetry:', error);
        }
      }

      const response = await fetch(
        `${getTelemetryIngestBaseUrl()}${TELEMETRY_INGEST_PATH}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: eventsToSend }),
        }
      );

      if (!response.ok) {
        throw new ResponseError(
          'Failed to flush telemetry events',
          response.status
        );
      }

      // Only remove events that were successfully sent
      this.events = this.events.filter(
        (event) => !eventsToSend.includes(event)
      );
      this.isFlushInProgress = false;

      // If there are still events to send, schedule another flush
      if (this.events.length > 0) {
        this.scheduleNextFlush();
      }
    } catch (error) {
      this.isFlushInProgress = false;

      // Schedule another attempt since an error occurred
      this.scheduleNextFlush();

      if (isSentryEnabled()) {
        const adapter = getSentryAdapter();
        // Check if this is a 4xx client error (expected) vs 5xx server error or network error (unexpected)
        const statusCode =
          error instanceof ResponseError ? error.statusCode : undefined;

        adapter?.addBreadcrumb({
          type: 'warn',
          level: 'warning',
          category: 'telemetry',
          message: 'Error flushing telemetry events',
          data: {
            error: error instanceof Error ? error.message : String(error),
            statusCode,
          },
        });
      }
    }
  }
}
