import { Context, Effect, Schema } from 'effect';
import { DispatchOutcome, Job, VersionedSchema } from 'tfx';
class Repository extends Context.Service<
	Repository,
	{ readonly value: string }
>()('types/JobRepository') {}
type Failure = { readonly _tag: 'Failure' };
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
	error: undefined as unknown as Failure,
	maxAttempts: 3,
	retry: () => Job.permanent,
});
const literal: 'literal-job' = declaration.name;
const implementation = Job.implement(declaration, (payload) => {
	const value: string = payload.value;
	return Effect.as(Repository, value);
});
type Requirement = (typeof implementation)['_R'];
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
