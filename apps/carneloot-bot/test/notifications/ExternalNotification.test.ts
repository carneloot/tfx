import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	classifyOutcome,
	ExternalNotificationInput,
	render,
} from '../../src/domain/notifications/ExternalNotification.js';

describe('external notification contract', () => {
	it('replaces every occurrence once, without interpreting dollars or replacement values as templates', async () => {
		expect(
			await Effect.runPromise(
				render('{{pet}} {{n}} {{pet}} {{other}}', {
					pet: '$& {{n}}',
					n: 0,
					other: 1.5,
				}),
			),
		).toBe('$& {{n}} 0 $& {{n}} 1.5');
		expect(await Effect.runPromise(render('No variables'))).toBe(
			'No variables',
		);
	});
	it('reports sorted, unique missing own-properties, not inherited names', async () => {
		const result = await Effect.runPromise(
			Effect.result(render('{{z}} {{a}} {{z}} {{toString}}', { z: 3 })),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'MissingTemplateVariables',
				variables: ['a', 'toString'],
			},
		});
	});
	it('accepts optional legacy variables but rejects non-string/finite-number values', () => {
		expect(
			Schema.decodeUnknownSync(ExternalNotificationInput)({
				apiKey: 'key',
				keyword: 'alarm',
			}),
		).toEqual({ apiKey: 'key', keyword: 'alarm' });
		for (const value of [null, true, {}, Infinity, NaN])
			expect(() =>
				Schema.decodeUnknownSync(ExternalNotificationInput)({
					apiKey: 'key',
					keyword: 'alarm',
					variables: { value },
				}),
			).toThrow();
	});
	it.each([
		[{ sent: 2, failed: 0, unknown: 0 }, 'sent', 200],
		[{ sent: 1, failed: 2, unknown: 0 }, 'partial', 207],
		[{ sent: 1, failed: 0, unknown: 1 }, 'partial', 207],
		[{ sent: 0, failed: 2, unknown: 0 }, 'failed', 502],
		[{ sent: 0, failed: 1, unknown: 2 }, 'indeterminate', 202],
	] as const)('classifies %j', (counts, status, httpStatus) =>
		expect(classifyOutcome(counts)).toEqual({ status, httpStatus }),
	);
});
