export { BaseOtelTracingClient } from './BaseOtelTracingClient';
export { OTLP_TRACES_INGEST_PATH } from './constants';
export { getBatchSpanProcessorConfig } from './config';
export { OtelTracing } from './OtelTracing';
export { SessionOrigin } from '@industry/drool-sdk-ext/protocol/session';
export {
  IndustryDaemonTransport,
  ClientUiSurface,
  SessionKind,
  SpanAttribute,
  SpanEvent,
  SpanName,
} from './enums';
export {
  deriveSessionAttributionFromPlatform,
  getIndustryCreateSessionSpanAttributes,
  getIndustrySessionAttributionAttributes,
} from './sessionAttributes';
export type {
  DerivedSessionAttribution,
  IndustryCreateSessionSpanParams,
  IndustrySessionAttributionParams,
  IndustrySessionOrigin,
  SessionAttributionPlatform,
} from './types';
export {
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
