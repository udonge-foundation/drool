/**
 * Static class for OTEL tracing operations
 * Provides a clean, callback-based API for automatic span lifecycle management
 *
 * @example
 * // Initialize once at app startup
 * OtelTracing.initialize(OtelClient);
 *
 * // Use trace() with automatic cleanup (supports sync and async)
 * await OtelTracing.trace('operation', async (span) => {
 *   span.addEvent('start');
 *   await doWork();
 * }, { 'key': 'value' });
 */

import {
  trace,
  context as otelContext,
  propagation,
  SpanStatusCode,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import { TraceContextMeta } from '@industry/drool-sdk-ext/protocol/shared';
import { toError } from '@industry/utils/errors';

import { SpanName } from './enums';

import type { BaseOtelTracingClient } from './BaseOtelTracingClient';
import type { Span, Context, Attributes } from '@opentelemetry/api';

// Use a dedicated propagator instance instead of relying on global propagator
const w3cPropagator = new W3CTraceContextPropagator();

// Store the client on globalThis so it survives webpack module duplication.
// In Next.js, each route bundle gets its own copy of module-level statics,
// so instrumentation.ts setting a static field only affects one copy.
// globalThis is shared across all bundles in the same Node.js process.
const GLOBAL_KEY = '__industryOtelTracingClient';

declare global {
  // eslint-disable-next-line no-var, vars-on-top -- var required for globalThis augmentation
  var __industryOtelTracingClient: BaseOtelTracingClient | undefined;
}

function getGlobalClient(): BaseOtelTracingClient | null {
  return globalThis[GLOBAL_KEY] ?? null;
}

function setGlobalClient(client: BaseOtelTracingClient): void {
  globalThis[GLOBAL_KEY] = client;
}

export class OtelTracing {
  /**
   * Initialize the OTEL tracing client
   * Should be called once at application startup
   */
  static initialize(client: BaseOtelTracingClient): void {
    setGlobalClient(client);
  }

  /**
   * Check if OTEL tracing is enabled and initialized
   */
  static isEnabled(): boolean {
    return getGlobalClient()?.isEnabled() ?? false;
  }

  /**
   * Inject trace context into a carrier object for propagation
   * Used to propagate trace context across service boundaries (e.g., WebSocket messages)
   *
   * Baggage (set via {@link OtelTracing.runWithAmbientAttributes}) is
   * intentionally NOT injected — only `traceparent` / `tracestate` go
   * on the wire. This keeps internal dimensions like
   * `industry.user.id` / `industry.org.id` / `industry.computer.id`
   * process-local: outbound HTTP calls (E2B, Orb, WorkOS, OpenAI, ...)
   * never see them in headers.
   *
   * @param carrier - Object to inject trace context into (will be mutated)
   * @param ctx - Context to inject from. REQUIRED. Pass the `spanContext`
   *   parameter from the enclosing `OtelTracing.trace(name, (span, ctx) => ...)`
   *   callback when possible — that is bulletproof across awaits. If you
   *   really want the ambient active context (only safe synchronously),
   *   pass `OtelTracing.getCurrentContext()` explicitly so the choice is
   *   visible in code.
   * @returns The carrier with injected trace context (traceparent, tracestate headers)
   */
  static injectContext<T extends TraceContextMeta>(
    carrier: T,
    ctx: Context
  ): T {
    w3cPropagator.inject(ctx, carrier, {
      set: (c: Record<string, unknown>, key: string, value: string) => {
        c[key] = value;
      },
    });
    return carrier;
  }

  /**
   * Extract trace context from a carrier object (e.g., incoming request _meta)
   * Used to receive trace context from upstream services for distributed tracing
   *
   * @param carrier - Object containing W3C trace context headers (traceparent, tracestate)
   * @returns The extracted Context, or undefined if no valid trace context found
   */
  static extractContext<T extends TraceContextMeta>(
    carrier?: T
  ): Context | undefined {
    if (!carrier?.traceparent) {
      return undefined;
    }
    return w3cPropagator.extract(otelContext.active(), carrier, {
      get: (c: Record<string, string | undefined>, key: string) => c[key],
      keys: (c: Record<string, string | undefined>) => Object.keys(c),
    });
  }

  /**
   * Get the current active context.
   * Useful for capturing context before async operations that may lose context.
   */
  static getCurrentContext(): Context {
    return otelContext.active();
  }

  /**
   * Stamp attributes onto the currently active span, if any. No-op when
   * OTEL is disabled or no span is active (e.g. middleware running
   * outside an instrumented request). Use this for cross-cutting
   * dimensions (auth principal, route params) that should appear on
   * every span emitted during a request.
   */
  static setActiveSpanAttributes(attributes: Attributes): void {
    const span = trace.getActiveSpan();
    if (!span) return;
    span.setAttributes(attributes);
  }

  /**
   * Run `fn` with a set of ambient span attributes attached to the
   * active OTel context via baggage. Every span subsequently created
   * via {@link OtelTracing.trace} inside `fn` (or its async
   * descendants) automatically inherits these attributes — so e.g.
   * stamping `industry.org.id` once at the API middleware boundary
   * makes it queryable on every child span without each handler
   * re-stamping it.
   *
   * Explicit attributes passed to `trace()` win on key collision.
   *
   * Baggage propagation note: `OtelTracing.injectContext` only
   * propagates `traceparent`/`tracestate` (not the `baggage` header),
   * so these stay process-local and never leak across service
   * boundaries.
   */
  static runWithAmbientAttributes<T>(
    attributes: Attributes,
    fn: () => Promise<T>
  ): Promise<T> {
    // Stamp the currently-active span too (typically the auto-
    // instrumented HTTP server span) so the request's root span
    // carries the dimensions even though OTel auto-instrumentation
    // doesn't read baggage on its own.
    OtelTracing.setActiveSpanAttributes(attributes);

    const ctx = otelContext.active();
    const existing = propagation.getBaggage(ctx);
    const builder = existing ?? propagation.createBaggage();
    let next = builder;
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null) continue;
      next = next.setEntry(key, { value: String(value) });
    }
    const newCtx = propagation.setBaggage(ctx, next);
    return otelContext.with(newCtx, fn);
  }

  /**
   * Read baggage entries from `ctx` and return them as a flat
   * `Attributes` object suitable for span creation. Values are
   * strings (OTel baggage type). Returns an empty object if no
   * baggage is set.
   */
  private static getAmbientAttributes(ctx: Context): Attributes {
    const baggage = propagation.getBaggage(ctx);
    if (!baggage) return {};
    const attrs: Attributes = {};
    for (const [key, entry] of baggage.getAllEntries()) {
      attrs[key] = entry.value;
    }
    return attrs;
  }

  /**
   * Run a function within a specific context without creating a new span.
   * Useful for propagating trace context across service boundaries where the
   * callee creates its own spans that should be children of the caller's span.
   *
   * @param context - The context to run within (e.g., from extractContext)
   * @param fn - The function to execute within the context
   * @returns The result of the function
   */
  static runInContext<T>(
    context: Context | undefined,
    fn: () => T | Promise<T>
  ): T | Promise<T> {
    if (!context) {
      return fn();
    }
    return otelContext.with(context, fn);
  }

  /**
   * Start a new span (internal use only)
   * Use trace() instead for automatic cleanup
   *
   * @internal
   */
  private static startSpan(
    name: SpanName,
    parentContext?: Context,
    attributes?: Attributes
  ): Span | null {
    return (
      getGlobalClient()?.startSpan(name, parentContext, attributes) ?? null
    );
  }

  /**
   * Run a function within a span context (supports both sync and async)
   * The span will be automatically ended when the function completes
   * Errors are caught, recorded to span, and rethrown
   *
   * The callback receives the span and its context. Use the context for nested
   * traces in browsers where async context propagation doesn't work.
   *
   * @example
   * // Basic usage
   * const result = await OtelTracing.trace('operation', async (span) => {
   *   span.addEvent('start');
   *   return await doWork();
   * });
   *
   * // With attributes
   * await OtelTracing.trace('operation', fn, { attributes: { key: 'value' } });
   *
   * // Nested traces in browser (use context for child spans after awaits)
   * await OtelTracing.trace('parent', async (span, ctx) => {
   *   await someAsync();
   *   await OtelTracing.trace('child', fn, { parentContext: ctx });
   * });
   */
  // Overload for sync callback
  static trace<T>(
    name: SpanName,
    fn: (span: Span, context: Context) => T,
    options?: { attributes?: Attributes; parentContext?: Context }
  ): T;

  // Overload for async callback
  // eslint-disable-next-line no-dupe-class-members
  static trace<T>(
    name: SpanName,
    fn: (span: Span, context: Context) => Promise<T>,
    options?: { attributes?: Attributes; parentContext?: Context }
  ): Promise<T>;

  // Implementation
  // eslint-disable-next-line no-dupe-class-members
  static trace<T>(
    name: SpanName,
    fn: (span: Span, context: Context) => T | Promise<T>,
    options?: { attributes?: Attributes; parentContext?: Context }
  ): T | Promise<T> {
    const { attributes, parentContext } = options ?? {};
    // Get the parent context BEFORE creating the span so nested traces inherit correctly
    const activeContext = parentContext ?? otelContext.active();
    // Merge ambient attributes from baggage so dimensions stamped via
    // `runWithAmbientAttributes` (industry.org.id, industry.computer.id,
    // etc.) automatically appear on every child span. Explicit per-call
    // attributes win on key collision.
    const ambient = OtelTracing.getAmbientAttributes(activeContext);
    const mergedAttributes =
      Object.keys(ambient).length === 0
        ? attributes
        : { ...ambient, ...(attributes ?? {}) };
    const span = OtelTracing.startSpan(name, activeContext, mergedAttributes);
    if (!span) {
      // OTEL not initialized, still run the function with a dummy span
      // This ensures code doesn't break when OTEL is disabled
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial dummy span for when OTEL is disabled; full Span interface cannot be implemented without the SDK
      const dummySpan = {
        addEvent: () => {},
        setAttributes: () => {},
        setStatus: () => {},
        recordException: () => {},
      } as unknown as Span;
      return fn(dummySpan, activeContext);
    }

    // Create context with span and run callback within it
    // This ensures context.active() returns the span's context inside the callback
    const spanContext = trace.setSpan(activeContext, span);

    const finishSpan = (error?: unknown) => {
      if (error) {
        const err = toError(error);
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
      }
      span.end();
    };

    // Execute the function within the span context
    // For async functions, we wrap in an async IIFE to keep context throughout
    return otelContext.with(spanContext, () => {
      try {
        // Pass spanContext to callback so it can be used for nested traces
        const result = fn(span, spanContext);

        // Check if result is a Promise
        if (result instanceof Promise) {
          // Return a new promise that handles completion within the context
          return result
            .then((value) => {
              finishSpan();
              return value;
            })
            .catch((error) => {
              finishSpan(error);
              throw error;
            });
        }

        // Sync result
        finishSpan();
        return result;
      } catch (error) {
        // Sync error
        finishSpan(error);
        throw error;
      }
    });
  }
}
