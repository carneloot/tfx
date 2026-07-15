import { Schema } from 'effect';
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
			retry: () => Job.retry(500),
		});
		expect(job.name).toBe('reminder');
		expect(job.payload.latest.version).toBe(1);
		expect(job.retry(new Failure({ message: 'failure' }))).toEqual({
			_tag: 'Retry',
			retryAfter: 500,
		});
		expect(job.schedule(1)).toBe(1000);
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
