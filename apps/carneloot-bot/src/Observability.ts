import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as OtlpLogger from 'effect/unstable/observability/OtlpLogger';
import * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization';
import * as OtlpTracer from 'effect/unstable/observability/OtlpTracer';

const resource = {
	serviceName: 'carneloot-bot',
};

const defaultOtelUrl = 'http://127.0.0.1:4318';

export const layer = Layer.unwrap(
	Effect.map(
		Config.all({
			tracesUrl: Config.string('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT').pipe(
				Config.withDefault(`${defaultOtelUrl}/v1/traces`),
			),
			logsUrl: Config.string('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT').pipe(
				Config.withDefault(`${defaultOtelUrl}/v1/logs`),
			),
		}),
		({ tracesUrl, logsUrl }) =>
			Layer.merge(
				OtlpTracer.layer({ url: tracesUrl, resource }),
				OtlpLogger.layer({ url: logsUrl, resource }),
			).pipe(
				Layer.provideMerge(OtlpSerialization.layerJson),
				Layer.provideMerge(FetchHttpClient.layer),
			),
	),
);
