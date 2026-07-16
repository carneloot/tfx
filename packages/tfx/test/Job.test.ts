import { Duration, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as Job from '../src/Job.js';
import * as VersionedSchema from '../src/VersionedSchema.js';

class Failure extends Schema.TaggedErrorClass<Failure>()('Failure', {
	message: Schema.String,
}) {}

describe('Job', () => {
	it('retains literal name, payload history, retry policy, and limits', () => {
		const history = VersionedSchema.history(
			VersionedSchema.version(1, Schema.String),
		);
		const job = Job.make('reminder', {
			payload: history,
			error: Failure,
			maxAttempts: 3,
			retry: () => Job.retry(Duration.millis(500)),
		});
		expect(job.name).toBe('reminder');
		expect(job.payload.latest.version).toBe(1);
		const decision = job.retry(new Failure({ message: 'failure' }));
		expect(decision?._tag).toBe('Retry');
		if (decision?._tag === 'Retry')
			expect(Duration.equals(decision.retryAfter!, Duration.millis(500))).toBe(
				true,
			);
		expect(Duration.equals(job.schedule(1), Duration.seconds(1))).toBe(true);
	});
	it('normalizes valid retry duration inputs and accepts zero', () => {
		for (const [input, expected] of [
			['500 millis', Duration.millis(500)],
			[Duration.seconds(2), Duration.seconds(2)],
			[0, Duration.zero],
		] as const) {
			const decision = Job.retry(input);
			expect(decision._tag).toBe('Retry');
			if (decision._tag === 'Retry')
				expect(Duration.equals(decision.retryAfter!, expected)).toBe(true);
		}
	});
	it('rejects invalid, negative, and infinite retry duration inputs', () => {
		for (const input of [
			Number.NaN,
			-1,
			Number.POSITIVE_INFINITY,
			'invalid duration',
		])
			expect(() => Job.retry(input as Duration.Input)).toThrow(TypeError);
	});
	it('rejects invalid max attempts', () => {
		const history = VersionedSchema.history(
			VersionedSchema.version(1, Schema.String),
		);
		expect(() =>
			Job.make('bad', {
				payload: history,
				error: Schema.Void,
				maxAttempts: 0,
				retry: () => Job.permanent,
			}),
		).toThrow('positive');
	});
});
