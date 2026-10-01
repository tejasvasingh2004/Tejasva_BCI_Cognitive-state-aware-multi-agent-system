import {
  context,
  metrics,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

let sdkShutdown: (() => Promise<void>) | undefined;

/**
 * Starts the OpenTelemetry Node SDK when an OTLP endpoint is configured. Without one, the API
 * stays in no-op mode so instrumentation calls are free. Must run before other imports that
 * should be auto-instrumented (http, pg, ioredis, fastify).
 */
export async function initTelemetry(serviceName: string): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') return false;

  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }, { OTLPMetricExporter }, { PeriodicExportingMetricReader }] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/auto-instrumentations-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-metrics'),
    ]);

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  sdkShutdown = () => sdk.shutdown();
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  await sdkShutdown?.().catch(() => {});
}

export const tracer = trace.getTracer('neuroflow');

/** Runs `fn` inside an active span; records errors and always ends the span. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Serialises the active trace context (for BullMQ job payloads). */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Runs `fn` with a trace context extracted from a job payload as the parent. */
export function withExtractedContext<T>(carrier: Record<string, string> | undefined, fn: () => T): T {
  if (!carrier) return fn();
  return context.with(propagation.extract(context.active(), carrier), fn);
}

const meter = metrics.getMeter('neuroflow');

/** Runtime metrics. Names follow `neuroflow.<area>.<measure>`; units are milliseconds/tokens. */
export const runtimeMetrics = {
  queueLatency: meter.createHistogram('neuroflow.run.queue_latency', { unit: 'ms' }),
  runDuration: meter.createHistogram('neuroflow.run.duration', { unit: 'ms' }),
  runsTotal: meter.createCounter('neuroflow.run.total'),
  modelLatency: meter.createHistogram('neuroflow.model.latency', { unit: 'ms' }),
  modelFirstToken: meter.createHistogram('neuroflow.model.first_token', { unit: 'ms' }),
  modelRetries: meter.createCounter('neuroflow.model.retries'),
  modelFallbacks: meter.createCounter('neuroflow.model.fallbacks'),
  modelErrors: meter.createCounter('neuroflow.model.errors'),
  tokens: meter.createCounter('neuroflow.model.tokens'),
  toolLatency: meter.createHistogram('neuroflow.tool.latency', { unit: 'ms' }),
  toolCalls: meter.createCounter('neuroflow.tool.calls'),
  evaluations: meter.createCounter('neuroflow.evaluation.total'),
  cost: meter.createCounter('neuroflow.run.cost', { unit: 'USD' }),
  authFailures: meter.createCounter('neuroflow.auth.failures'),
};
