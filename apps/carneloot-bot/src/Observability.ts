import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as OtlpLogger from 'effect/unstable/observability/OtlpLogger';
import * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization';
import * as OtlpTracer from 'effect/unstable/observability/OtlpTracer';

export const otlpResource = Object.freeze({
	serviceName: 'carneloot-bot',
});
export const defaultOtlpEndpoints = Object.freeze({
	tracesUrl: 'http://127.0.0.1:4318/v1/traces',
	logsUrl: 'http://127.0.0.1:4318/v1/logs',
});

export const layer = Layer.unwrap(
	Effect.map(
		Config.all({
			tracesUrl: Config.string('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT').pipe(
				Config.withDefault(defaultOtlpEndpoints.tracesUrl),
			),
			logsUrl: Config.string('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT').pipe(
				Config.withDefault(defaultOtlpEndpoints.logsUrl),
			),
		}),
		({ tracesUrl, logsUrl }) =>
			Layer.merge(
				OtlpTracer.layer({ url: tracesUrl, resource: otlpResource }),
				OtlpLogger.layer({ url: logsUrl, resource: otlpResource }),
			).pipe(
				Layer.provideMerge(OtlpSerialization.layerJson),
				Layer.provide(FetchHttpClient.layer),
			),
	),
);
