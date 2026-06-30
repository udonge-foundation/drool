import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';

import { SpanName } from './enums';

import type { Span, Context, Attributes } from '@opentelemetry/api';

interface BaseOtelTracingClientParams {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  deploymentEnv: string;
  /** Extra resource attributes merged into every span (use the `industry.*` namespace). */
  extraResourceAttributes?: Attributes;
}

/**
 * Base interface for OTEL tracing clients
 * Provides span management without platform-specific dependencies
 */
export abstract class BaseOtelTracingClient {
  protected enabled: boolean;

  protected serviceName: string;

  protected serviceVersion: string;

  protected deploymentEnv: string;

  protected extraResourceAttributes: Attributes;

  protected constructor({
    enabled,
    serviceName,
    serviceVersion,
    deploymentEnv,
    extraResourceAttributes = {},
  }: BaseOtelTracingClientParams) {
    this.enabled = enabled;
    this.serviceName = serviceName;
    this.serviceVersion = serviceVersion;
    this.deploymentEnv = deploymentEnv;
    this.extraResourceAttributes = extraResourceAttributes;
  }

  /** Resource attributes applied to all spans for this client. */
  getResourceAttributes(): Attributes {
    return {
      [ATTR_SERVICE_NAME]: this.serviceName,
      [ATTR_SERVICE_VERSION]: this.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: this.deploymentEnv,
      ...this.extraResourceAttributes,
    };
  }

  /**
   * Start a new span
   * @param name Span name (e.g., 'session.create', 'sandbox.restart')
   * @param parentContext Optional parent context for distributed tracing
   * @param attributes Span attributes
   * @returns Span instance, or undefined if OTEL not enabled
   */
  abstract startSpan(
    name: SpanName,
    parentContext?: Context,
    attributes?: Attributes
  ): Span | undefined;

  /**
   * Check if OTEL is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }
}
