import { context, trace, SpanStatusCode, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Local-first exporter: one JSON line per finished span under <dataDir>/traces. */
export class JsonlFileSpanExporter implements SpanExporter {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `spans-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      const lines = spans.map((s) =>
        JSON.stringify({
          traceId: s.spanContext().traceId,
          spanId: s.spanContext().spanId,
          parentSpanId: s.parentSpanContext?.spanId ?? null,
          name: s.name,
          start: hrToIso(s.startTime),
          durationMs: s.duration[0] * 1e3 + s.duration[1] / 1e6,
          status: s.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
          error: s.status.message ?? null,
          attributes: s.attributes,
          events: s.events.map((e) => ({ name: e.name, time: hrToIso(e.time), attributes: e.attributes })),
        }),
      );
      if (lines.length) appendFileSync(this.file, lines.join('\n') + '\n');
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {}
}

function hrToIso(t: [number, number]): string {
  return new Date(t[0] * 1e3 + t[1] / 1e6).toISOString();
}

export interface TelemetryOptions {
  dataDir: string;
  fileExport: boolean;
  /** Optional OTLP/HTTP endpoint (Tempo, Jaeger, collector). Not required. */
  otlpEndpoint: string | null;
  /** Extra exporter, e.g. an in-memory one for tests. */
  exporter?: SpanExporter;
}

export class Telemetry {
  readonly tracer: Tracer;
  private readonly provider: BasicTracerProvider;

  private constructor(provider: BasicTracerProvider) {
    this.provider = provider;
    this.tracer = provider.getTracer('agent-cockpit', '0.1.0');
  }

  static async init(opts: TelemetryOptions): Promise<Telemetry> {
    const processors: SpanProcessor[] = [];
    if (opts.fileExport) processors.push(new BatchSpanProcessor(new JsonlFileSpanExporter(join(opts.dataDir, 'traces')), { scheduledDelayMillis: 1000 }));
    if (opts.exporter) processors.push(new SimpleSpanProcessor(opts.exporter));
    if (opts.otlpEndpoint) {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.otlpEndpoint })));
    }
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'agent-cockpit-orchestrator', [ATTR_SERVICE_VERSION]: '0.1.0' }),
      spanProcessors: processors,
    });
    return new Telemetry(provider);
  }

  /** Run `fn` inside a span. The span is ended and its status set from the outcome. */
  async span<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, parent?: Span): Promise<T> {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
    const span = this.tracer.startSpan(name, { attributes: clean(attributes) }, ctx);
    const started = Date.now();
    try {
      const out = await context.with(trace.setSpan(ctx, span), () => fn(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setAttribute('error.type', (err as Error)?.name ?? 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.setAttribute('cockpit.duration_ms', Date.now() - started);
      span.end();
    }
  }

  /** Long-lived span (a run, a human-approval wait) ended explicitly later. */
  start(name: string, attributes: Attributes, parent?: Span): Span {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
    return this.tracer.startSpan(name, { attributes: clean(attributes) }, ctx);
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

function clean(attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export type { Span, Attributes } from '@opentelemetry/api';
