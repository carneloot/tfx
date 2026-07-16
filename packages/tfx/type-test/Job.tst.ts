import { Context, Effect, Schema } from 'effect';
import type * as DateTime from 'effect/DateTime';
import type * as Duration from 'effect/Duration';
import { DispatchOutcome, Job, VersionedSchema } from 'tfx';
import type { JobRecord } from 'tfx/JobStore';
class Repository extends Context.Service<
	Repository,
	{ readonly value: string }
>()('types/JobRepository') {}
class Failure extends Schema.TaggedErrorClass<Failure>()('Failure', {}) {}
const history = VersionedSchema.history(
	VersionedSchema.version(1, Schema.Struct({ old: Schema.String })),
).pipe(
	VersionedSchema.to(
		VersionedSchema.version(2, Schema.Struct({ value: Schema.String })),
		(payload) => ({ value: payload.old }),
	),
);
const declaration = Job.make('literal-job', {
	payload: history,
	error: Failure,
	maxAttempts: 3,
	retry: () => Job.permanent,
});
const literal: 'literal-job' = declaration.name;
const implementation = Job.implement(declaration, (payload) => {
	const value: string = payload.value;
	return Effect.as(Repository, value);
});
type Requirement = NonNullable<(typeof implementation)['_R']>;
const requirement: Requirement = undefined as unknown as Repository;
void literal;
void requirement;
// @ts-expect-error wrong current payload
Job.implement(declaration, (_payload: { old: string }) => Effect.void);
// @ts-expect-error handler error must be declared
Job.implement(declaration, () => Effect.fail('bad'));
// @ts-expect-error retryable dispatch outcomes are never persisted as completed
const invalidCompleted: DispatchOutcome.CompletedOutcome =
	DispatchOutcome.retryableFailure('retry');
void invalidCompleted;
declare const record: JobRecord;
const runAt: DateTime.Utc = record.runAt;
const leaseExpiresAt: DateTime.Utc | undefined = record.leaseExpiresAt;
const createdAt: DateTime.Utc = record.createdAt;
const updatedAt: DateTime.Utc = record.updatedAt;
declare const retryDecision: Job.RetryDecision;
if (retryDecision._tag === 'Retry') {
	const retryAfter: Duration.Duration | undefined = retryDecision.retryAfter;
	void retryAfter;
}
// @ts-expect-error epoch numbers are not job instants
const invalidRunAt: number = record.runAt;
// @ts-expect-error duration millis are not retry durations
const invalidRetryAfter: number | undefined =
	retryDecision._tag === 'Retry' ? retryDecision.retryAfter : undefined;
void runAt;
void leaseExpiresAt;
void createdAt;
void updatedAt;
void invalidRunAt;
void invalidRetryAfter;
