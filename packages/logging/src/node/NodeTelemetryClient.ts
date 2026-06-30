import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { trace } from '@opentelemetry/api';

import { fetch } from '@industry/drool-core/api/fetch';
import { getIndustryTelemetryIngestBaseUrl } from '@industry/utils/environment';

import { rotateLogFileIfNeeded } from './logRotation';
import { LogLevel, TelemetryEventType } from '../enums';
import { MetaError } from '../errors';
import { LogMetadata, LogOptions } from '../metadata/types';
import { MetricLabels } from '../metrics/types';
import { getSentryAdapter, isSentryEnabled } from '../sentry';
import { TELEMETRY_INGEST_PATH } from '../tracing/constants';
import {
  TelemetryEvent,
  PrivateAttributes,
  LogToConsoleFunction,
  TelemetryClientConfig,
} from '../types';
import { normalizedMetadata } from '../utils';

/**
 * Node.js telemetry client base class.
 * Provides common functionality for event handling, flushing, and logging in Node.js environments.
 * Platform-specific clients should extend this class and override methods as needed.
 */
export abstract class NodeTelemetryClient {
  // Singleton management (subclasses will use this pattern)
  // eslint-disable-next-line no-use-before-define
  protected static instance: NodeTelemetryClient | null = null;

  protected webEvents: Array<{ _queuedAt: number; [key: string]: unknown }> =
    [];

  protected diskEvents: Array<{
    level: string;
    message: string;
    context: unknown;
    timestamp: string;
  }> = [];

  protected flushTimeout: NodeJS.Timeout | null = null;

  protected readonly FLUSH_INTERVAL_MS: number = 20000; // Default 20 seconds

  protected readonly MAX_EVENTS_PER_FLUSH: number = 1000;

  private readonly MAX_WEB_EVENTS: number = 5000;

  private readonly MAX_EVENT_AGE_MS: number = 5 * 60 * 1000; // 5 minutes

  private readonly MAX_CONSECUTIVE_FAILURES: number = 3;

  private readonly MAX_BACKOFF_MS: number = 5 * 60 * 1000; // 5 minutes

  private consecutiveFlushFailures: number = 0;

  private isFlushInProgress: boolean = false;

  private authTokenGetter: (() => Promise<string | null>) | null = null;

  protected logFilePath: string | null = null;

  protected config: TelemetryClientConfig;

  protected alsoLogToConsole: boolean = false;

  private detectedOsName: string | null = null;

  /**
   * High-level initialization method that must be implemented by subclasses.
   * Each subclass should provide its own initialization logic and configuration handling.
   *
   * @throws {MetaError} Always throws - must be implemented by subclass
   */
  public static initialize(..._args: unknown[]): void {
    throw new MetaError(
      'initialize() must be implemented by subclass. NodeTelemetryClient cannot be initialized directly.'
    );
  }

  /**
   * Low-level industry method to create a telemetry client instance.
   * This method ensures the log directory exists before constructing the instance.
   *
   * @internal - Called by subclass `initialize()` methods only.
   */
  protected static async init<
    T extends NodeTelemetryClient,
    C extends { logFilePath: string },
  >(
    this: (new (config: C) => T) & {
      ensureDirectoryExists(filePath: string): Promise<void>;
    },
    config: C
  ): Promise<T> {
    // Ensure directory exists before constructing the instance
    if (config.logFilePath) {
      await this.ensureDirectoryExists(config.logFilePath);
    }
    return new this(config);
  }

  /**
   * Ensure a directory exists (Node.js only).
   * Default implementation using Node.js fs module.
   * Subclasses can override if needed.
   */
  static async ensureDirectoryExists(filePath: string): Promise<void> {
    const logDir = path.dirname(filePath);
    await fs.mkdir(logDir, { recursive: true });
  }

  constructor(config: TelemetryClientConfig) {
    this.config = config;
    if (config.flushIntervalMs) {
      this.FLUSH_INTERVAL_MS = config.flushIntervalMs;
    }
    if (config.maxEventsPerFlush) {
      this.MAX_EVENTS_PER_FLUSH = config.maxEventsPerFlush;
    }
    this.logFilePath = config.logFilePath;
    this.alsoLogToConsole = config.alsoLogToConsole ?? false;
  }

  /**
   * Get platform-specific tags for telemetry events.
   * Override this method in subclasses to add platform-specific tags.
   */
  protected getAdditionalTags(): Record<string, string> {
    return {};
  }

  public setAuthTokenGetter(getter: () => Promise<string | null>): void {
    this.authTokenGetter = getter;
  }

  /**
   * Append content to a file (Node.js only).
   * Default implementation using Node.js fs module.
   * Subclasses can override if needed.
   *
   * Rotates the file in-place when it exceeds the configured size cap so
   * long-running daemons cannot fill the disk with a single log file.
   */
  protected async appendToFile(
    filePath: string,
    content: string
  ): Promise<void> {
    await rotateLogFileIfNeeded(filePath, {
      maxBytesPerFragment: this.config.logRotationMaxBytesPerFragment,
      maxDays: this.config.logRotationMaxDays,
      maxTotalBytes: this.config.logRotationMaxTotalBytes,
      onError: this.config.logRotationOnError,
    });
    await fs.appendFile(filePath, content);
  }

  /**
   * Get OS name with caching.
   * Default implementation using Node.js os module.
   * Subclasses can override if needed.
   */
  protected getOsName(): string {
    if (this.detectedOsName) return this.detectedOsName;
    this.detectedOsName = `${os.platform()} ${os.release()}`;
    return this.detectedOsName;
  }

  /**
   * Set the log file path for disk logging
   */
  public setLogFilePath(logFilePath: string | null): void {
    this.logFilePath = logFilePath;
  }

  /**
   * Get web events for processing
   */
  public getWebEvents(): Array<{ _queuedAt: number; [key: string]: unknown }> {
    return this.webEvents;
  }

  /**
   * Set web events after processing
   */
  public setWebEvents(
    events: Array<{ _queuedAt: number; [key: string]: unknown }>
  ): void {
    this.webEvents = events;
  }

  /**
   * Get disk events for processing
   */
  public getDiskEvents(): Array<{
    level: string;
    message: string;
    context: unknown;
    timestamp: string;
  }> {
    return this.diskEvents;
  }

  /**
   * Clear disk events after processing
   */
  public clearDiskEvents(): void {
    this.diskEvents = [];
  }

  /**
   * Schedule next flush manually
   */
  public scheduleNextFlushPublic(): void {
    this.scheduleNextFlush();
  }

  /**
   * Format a disk event for logging
   */
  protected static formatDiskEvent(diskEvent: {
    level: string;
    message: string;
    context: unknown;
    timestamp: string;
  }): string {
    const { level, message, context, timestamp } = diskEvent;
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}`;
  }

  /**
   * Add an event to the telemetry queue
   */
  protected async addEvent(
    event: TelemetryEvent,
    skipWebTelemetry: boolean = false
  ): Promise<void> {
    const clientTimestamp = new Date();

    const combinedAttributes: PrivateAttributes = {
      ...event.attributes,
      clientTimestampMs: clientTimestamp.getTime(),
      clientPath: this.config.clientPath,
      isClientMetric:
        event.type === TelemetryEventType.METRIC ? true : undefined,
      isClientLog: event.type === TelemetryEventType.LOG ? true : undefined,
      clientPlatform: this.config.clientPlatform,
    };

    const tags: Record<string, string> = {
      ...(combinedAttributes.tags || {}),
    };

    const hasSnapshotTags =
      combinedAttributes.tags &&
      Object.keys(combinedAttributes.tags).length > 0;

    // Add platform-specific tags only when no snapshot tags were attached at emission time
    if (!hasSnapshotTags) {
      const additionalTags = this.getAdditionalTags();
      // Do not overwrite any existing tags (e.g. from explicit metadata)
      for (const [key, value] of Object.entries(additionalTags)) {
        if (tags[key] === undefined) {
          tags[key] = value;
        }
      }
    }

    if (Object.keys(tags).length > 0) {
      combinedAttributes.tags = tags;
    }

    // Only add to web events if web telemetry is not skipped
    if (!skipWebTelemetry) {
      // Cap queue size by dropping oldest events
      if (this.webEvents.length >= this.MAX_WEB_EVENTS) {
        this.webEvents.splice(
          0,
          this.webEvents.length - this.MAX_WEB_EVENTS + 1
        );
      }

      this.webEvents.push({
        ...event,
        attributes: combinedAttributes,
        _queuedAt: Date.now(),
      });
    }

    const diskEvent = {
      level: event.level || 'info',
      message: event.message || '',
      context: event.attributes,
      timestamp: clientTimestamp.toISOString(),
    };
    this.diskEvents.push(diskEvent);

    // If skipWebTelemetry is true, force an immediate flush to disk only
    if (skipWebTelemetry) {
      await this.flushToDisk();
    } else if (!this.flushTimeout) {
      // Only schedule a flush if one isn't already scheduled
      this.scheduleNextFlush();
    }

    if (this.alsoLogToConsole) {
      // eslint-disable-next-line no-console
      console.log(
        `${diskEvent.level.toUpperCase()}: ${diskEvent.message}`,
        combinedAttributes
      );
    }
  }

  /**
   * Schedule the next flush operation with exponential backoff on repeated failures.
   */
  protected scheduleNextFlush(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    const backoffDelay =
      this.consecutiveFlushFailures > 0
        ? Math.min(
            this.FLUSH_INTERVAL_MS * 2 ** this.consecutiveFlushFailures,
            this.MAX_BACKOFF_MS
          )
        : this.FLUSH_INTERVAL_MS;

    this.flushTimeout = setTimeout(async () => {
      this.flushTimeout = null;
      if (this.isFlushInProgress) return;
      this.isFlushInProgress = true;
      try {
        await this.flushToDisk();
        await this.flushToWeb();
      } finally {
        this.isFlushInProgress = false;
      }
    }, backoffDelay);
  }

  /**
   * Force a flush operation
   */
  public async forceFlush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.isFlushInProgress) return;
    this.isFlushInProgress = true;
    try {
      await this.flushToDisk();
      await this.flushToWeb(true);
    } finally {
      this.isFlushInProgress = false;
    }
  }

  /**
   * Flush events to disk
   */
  protected async flushToDisk(): Promise<void> {
    if (!this.logFilePath || this.diskEvents.length === 0) return;

    let writeSucceeded = false;

    try {
      // Ensure directory exists using the static method of the concrete subclass
      await // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing static method via this.constructor for polymorphism; TS can't narrow Function to concrete class
      (this.constructor as typeof NodeTelemetryClient).ensureDirectoryExists(
        this.logFilePath
      );

      // Format events for disk
      const events = this.diskEvents.map((diskEvent) =>
        NodeTelemetryClient.formatDiskEvent(diskEvent)
      );

      // Append to file
      await this.appendToFile(this.logFilePath, `${events.join('\n')}\n`);
      writeSucceeded = true;
    } catch (error) {
      // eslint-disable-next-line no-console -- Cannot use log functions inside the logging infrastructure (infinite recursion)
      console.warn('Error flushing telemetry events to disk:', error);
    }

    // Only clear events that were actually written successfully
    if (writeSucceeded) {
      this.diskEvents = [];
    }
  }

  /**
   * Flush events to web
   */
  protected async flushToWeb(flushAll: boolean = false): Promise<void> {
    if (this.config.isWebTelemetryDisabled?.()) {
      // Web telemetry suppressed (e.g. CLI airgap mode). Drop the queue
      // so it doesn't grow unboundedly while disk logging continues.
      this.webEvents = [];
      return;
    }
    // Evict stale events before attempting to send
    const now = Date.now();
    this.webEvents = this.webEvents.filter(
      (event) => now - event._queuedAt < this.MAX_EVENT_AGE_MS
    );

    if (this.webEvents.length === 0) return;
    const eventsToSend = flushAll
      ? [...this.webEvents]
      : this.webEvents.slice(0, this.MAX_EVENTS_PER_FLUSH);

    let sendSucceeded = false;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.authTokenGetter) {
        try {
          const token = await this.authTokenGetter();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }
        } catch (error) {
          // eslint-disable-next-line no-console -- logging infra can't use log fns (recursion)
          console.warn('Failed to get auth token for telemetry:', error);
        }
      }

      const response = await fetch(
        `${getIndustryTelemetryIngestBaseUrl()}${TELEMETRY_INGEST_PATH}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: eventsToSend }),
        }
      );

      if (!response.ok) {
        throw new MetaError('Failed to flush telemetry events');
      }

      sendSucceeded = true;
    } catch (error) {
      // DO NOT log to Sentry or Axiom if this fails. The noise is too high and calling log will recurse.
      // eslint-disable-next-line no-console -- Cannot use log functions inside the logging infrastructure (infinite recursion)
      console.warn('Error flushing telemetry events to web:', error);
    }

    if (sendSucceeded) {
      this.consecutiveFlushFailures = 0;
      this.webEvents = this.webEvents.filter(
        (event) => !eventsToSend.includes(event)
      );
    } else {
      this.consecutiveFlushFailures++;

      // After too many consecutive failures, drop all events to break the retry storm
      if (this.consecutiveFlushFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.webEvents = [];
        this.consecutiveFlushFailures = 0;
        return;
      }
    }

    // If there are still events to send, schedule another flush (with backoff)
    if (this.webEvents.length > 0) {
      this.scheduleNextFlush();
    }
  }

  /**
   * Add a metric event
   * DO NOT CALL THIS METHOD DIRECTLY, use `Metrics.*` methods instead
   */
  public async addMetric_INTERNAL_USE_ONLY(
    name: string,
    value: number,
    labels: MetricLabels = {}
  ): Promise<void> {
    // Snapshot platform-specific tags at metric emission time to avoid races with mutable client state
    const additionalTags = this.getAdditionalTags();

    const existingTags = labels.tags || {};
    const mergedTags =
      Object.keys(additionalTags).length || Object.keys(existingTags).length
        ? { ...additionalTags, ...existingTags }
        : undefined;

    const attributes: MetricLabels = {
      ...labels,
    };

    if (mergedTags) {
      attributes.tags = mergedTags;
    }

    await this.addEvent({
      type: TelemetryEventType.METRIC,
      name,
      value,
      attributes,
    });
  }

  /**
   * Add a log event
   * DO NOT CALL THIS METHOD DIRECTLY, use `logInfo`, `logWarn`, or `logError` instead
   */
  public async addLog_INTERNAL_USE_ONLY(
    level: LogLevel,
    message: string,
    metadata: LogMetadata = {},
    options: LogOptions = {}
  ): Promise<void> {
    // Snapshot platform-specific tags at log time to avoid races with mutable client state
    const additionalTags = this.getAdditionalTags();

    // Tags may be present from PrivateAttributes (extends MetricLabels) even though metadata is typed as LogMetadata
    const existingTags: Record<string, string> =
      'tags' in metadata &&
      typeof metadata.tags === 'object' &&
      metadata.tags !== null
        ? { ...metadata.tags }
        : {};
    const otelSpanContext = trace.getActiveSpan()?.spanContext();
    if (otelSpanContext?.traceId)
      existingTags.traceId = otelSpanContext.traceId;
    if (otelSpanContext?.spanId) existingTags.spanId = otelSpanContext.spanId;

    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      const sentrySpan = adapter?.getActiveSpan()?.spanContext();
      if (sentrySpan?.traceId) existingTags.sentryTraceId = sentrySpan.traceId;
      if (sentrySpan?.spanId) existingTags.sentrySpanId = sentrySpan.spanId;
    }

    const mergedTags =
      Object.keys(additionalTags).length || Object.keys(existingTags).length
        ? { ...additionalTags, ...existingTags }
        : undefined;

    const metadataWithTags: Record<string, unknown> = {
      ...metadata,
    };

    if (mergedTags) {
      // Stored under `tags` so downstream telemetry (Axiom, Sentry) can treat them as labels
      metadataWithTags.tags = mergedTags;
    }

    // Normalize metadata to serialize Error objects and filter undefined values
    const normalized = normalizedMetadata(metadataWithTags);

    // Pass skipWebTelemetry from options to addEvent
    await this.addEvent(
      {
        type: TelemetryEventType.LOG,
        level,
        message,
        attributes: normalized || {},
      },
      options.skipWebTelemetry === true
    );
  }

  /**
   * Get the log function bound to this instance
   * This is what gets passed to loggingConfig
   */
  public getLogFunction(): LogToConsoleFunction {
    return (level, message, metadata, options) => {
      // Use void to explicitly ignore the promise
      void this.addLog_INTERNAL_USE_ONLY(level, message, metadata, options);
    };
  }
}
