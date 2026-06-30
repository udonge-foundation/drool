/**
 * CLI OpenTelemetry tracing client. Used for TUI, drool exec, drool
 * acp, and drool daemon modes. The global instance may be replaced
 * mid-process when the CLI dispatches into the daemon command.
 */

import {
  context,
  type Span,
  type Context,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import { ServiceName } from '@industry/common/shared';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  SpanName,
  BaseOtelTracingClient,
  OTLP_TRACES_INGEST_PATH,
  getBatchSpanProcessorConfig,
} from '@industry/logging/tracing';
import { getIndustryTelemetryIngestBaseUrl } from '@industry/utils/environment';

import packageJson from '../../../package.json';
import { getAuthHeaders } from '@/api/config';
import { getEnv } from '@/environment';

interface CliOtelConfig {
  enabled: boolean;
  /** OTEL service.name override. Defaults to ServiceName.CLI; daemon command passes ServiceName.Daemon. */
  serviceName?: ServiceName;
  /** Extra resource attributes merged into every span (use the `industry.*` namespace). */
  extraResourceAttributes?: Attributes;
}

export class CliOtelTracingClient extends BaseOtelTracingClient {
  private provider: NodeTracerProvider | null = null;

  private tracer: Tracer | null = null;

  constructor(config: CliOtelConfig) {
    super({
      enabled: config.enabled,
      serviceName: config.serviceName ?? ServiceName.CLI,
      serviceVersion: packageJson.version,
      deploymentEnv: getEnv().deploymentEnv ?? 'development',
      extraResourceAttributes: config.extraResourceAttributes,
    });

    if (this.enabled) {
      this.initializeProvider();
    }
  }

  /**
   * Initialize OTEL provider for CLI
   */
  private initializeProvider(): void {
    const otlpEndpoint = `${getIndustryTelemetryIngestBaseUrl()}${OTLP_TRACES_INGEST_PATH}`;

    // Configure OTLP exporter to send traces to the telemetryIngest cloud function.
    const exporter = new OTLPTraceExporter({
      url: otlpEndpoint,
      timeoutMillis: 10000,
      headers: getAuthHeaders,
    });

    // Create Node Tracer Provider
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes(this.getResourceAttributes()),
      spanProcessors: [
        new BatchSpanProcessor(exporter, getBatchSpanProcessorConfig()),
      ],
    });

    this.provider.register();

    // Use provider's tracer directly to ensure spans go through our processors
    this.tracer = this.provider.getTracer(
      this.serviceName,
      this.serviceVersion
    );

    logInfo('[CliOtelTracingClient] CLI telemetry initialized', {
      serviceName: this.serviceName,
    });
  }

  /**
   * Start a new span
   * @param name Span name (e.g., 'session.create', 'tool.execute')
   * @param parentContext Optional parent context for distributed tracing
   * @param attributes Span attributes
   * @returns Span instance, or undefined if OTEL not initialized
   */
  public startSpan(
    name: SpanName,
    parentContext?: Context,
    attributes: Attributes = {}
  ): Span | undefined {
    if (!this.enabled) {
      return undefined;
    }

    if (!this.tracer) {
      throw new MetaError('Tracer not initialized');
    }

    const ctx = parentContext || context.active();
    return this.tracer.startSpan(name, { attributes }, ctx);
  }

  /**
   * Shutdown the tracer provider gracefully
   */
  public async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
  }
}
