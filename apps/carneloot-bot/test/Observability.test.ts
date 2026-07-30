import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { describe, expect, it } from 'vitest';

import * as Observability from '../src/Observability.js';

const { defaultOtlpEndpoints, otlpResource } = Observability;

describe('production observability', () => {
	it('uses immutable local OTLP defaults and carneloot resource without network export', async () => {
		await Effect.runPromise(Effect.scoped(Layer.build(Observability.layer)));
		expect(defaultOtlpEndpoints).toEqual({
			tracesUrl: 'http://127.0.0.1:4318/v1/traces',
			logsUrl: 'http://127.0.0.1:4318/v1/logs',
		});
		expect(otlpResource).toEqual({ serviceName: 'carneloot-bot' });
		expect(Object.isFrozen(defaultOtlpEndpoints)).toBe(true);
		expect(Object.isFrozen(otlpResource)).toBe(true);
	});
});
