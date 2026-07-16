import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import * as Job from './Job.js';
import * as JobOutcome from './JobOutcome.js';
import { JobStore, JobStoreError, type JobRecord } from './JobStore.js';
import { VersionedSchemaError } from './VersionedSchema.js';
export class JobRuntimeOptionsError extends Data.TaggedError(
	'JobRuntimeOptionsError',
)<{
	readonly option: 'leaseDuration' | 'heartbeatInterval';
	readonly message: string;
}> {}
export type JobRuntimeError = JobStoreError | JobRuntimeOptionsError;

export interface JobRuntimeService {
	readonly schedule: <J extends Job.Job<any, any, any>>(
		job: J,
		payload: Job.Payload<J>,
		options?: { readonly runAt?: DateTime.Utc; readonly conflictKey?: string },
	) => Effect.Effect<
		{ readonly id: string; readonly replacedId?: string },
		JobStoreError
	>;
	readonly runOne: (options?: {
		readonly leaseDuration?: Duration.Input;
		readonly heartbeatInterval?: Duration.Input;
	}) => Effect.Effect<JobRecord | undefined, JobRuntimeError>;
	readonly problems: Effect.Effect<ReadonlyArray<JobRecord>, JobStoreError>;
	readonly cancel: (id: string) => Effect.Effect<boolean, JobStoreError>;
	readonly releaseFailed: (
		id: string,
		options: { readonly reason: string; readonly resetAttempts?: boolean },
	) => Effect.Effect<JobRecord, JobStoreError>;
}
export class JobRuntime extends Context.Service<
	JobRuntime,
	JobRuntimeService
>()('tfx/JobRuntime') {}
type AnyImplementation = Job.Implementation<Job.Job<any, any, any>, any>;
class CancelSignal {
	readonly _tag = 'CancelSignal';
}
class LeaseSignal {
	readonly _tag = 'LeaseSignal';
}
type Requirements<I extends ReadonlyArray<AnyImplementation>> =
	I[number] extends Job.Implementation<any, infer R> ? R : never;
export const layer = <const I extends ReadonlyArray<AnyImplementation>>(
	...implementations: I
): Layer.Layer<JobRuntime, never, JobStore | Requirements<I>> =>
	Layer.effect(
		JobRuntime,
		Effect.gen(function* () {
			const store = yield* JobStore;
			const infrastructure = yield* Effect.context<Requirements<I>>();
			const byName = new Map(
				implementations.map((i) => [i.declaration.name, i]),
			);
			const service: JobRuntimeService = {
				problems: store.problems(),
				schedule: (job, payload, options = {}) =>
					Effect.gen(function* () {
						const now = yield* DateTime.now;
						const result = yield* store.schedule({
							name: job.name,
							payload,
							payloadVersion: job.payload.latest.version,
							maxAttempts: job.maxAttempts,
							runAt: options.runAt ?? now,
							now,
							...(options.conflictKey === undefined
								? {}
								: { conflictKey: options.conflictKey }),
						});
						return {
							id: result.record.id,
							...(result.replacedId === undefined
								? {}
								: { replacedId: result.replacedId }),
						};
					}),
				runOne: (options = {}) =>
					Effect.gen(function* () {
						const leaseDuration = Option.getOrElse(
							Duration.fromInput(options.leaseDuration ?? Duration.seconds(30)),
							() => Duration.infinity,
						);
						const heartbeatInterval = Option.getOrElse(
							Duration.fromInput(
								options.heartbeatInterval ??
									Duration.millis(
										Math.max(
											1,
											Math.floor(Duration.toMillis(leaseDuration) / 3),
										),
									),
							),
							() => Duration.infinity,
						);
						if (
							!Duration.isFinite(leaseDuration) ||
							!Duration.isPositive(leaseDuration)
						)
							return yield* Effect.fail(
								new JobRuntimeOptionsError({
									option: 'leaseDuration',
									message: 'leaseDuration must be finite and positive',
								}),
							);
						if (
							!Duration.isFinite(heartbeatInterval) ||
							!Duration.isPositive(heartbeatInterval) ||
							!Duration.isLessThan(heartbeatInterval, leaseDuration)
						)
							return yield* Effect.fail(
								new JobRuntimeOptionsError({
									option: 'heartbeatInterval',
									message:
										'heartbeatInterval must be finite, positive, and less than leaseDuration',
								}),
							);
						const claimNow = yield* DateTime.now;
						const claim = yield* store.claimForMigration(
							claimNow,
							leaseDuration,
						);
						if (claim === undefined) return undefined;
						const implementation = byName.get(claim.record.name);
						if (implementation === undefined) {
							yield* store.quarantineMigration(
								claim.token,
								'UnknownDeclaration',
								yield* DateTime.now,
							);
							return yield* store.get(claim.record.id);
						}
						const declaration = implementation.declaration;
						if (
							claim.record.payloadVersion > declaration.payload.latest.version
						) {
							yield* store.quarantineMigration(
								claim.token,
								'NewerPayloadVersion',
								yield* DateTime.now,
							);
							return yield* store.get(claim.record.id);
						}
						const migrated = yield* Effect.result(
							declaration.payload.migrate(
								claim.record.payloadVersion,
								claim.record.payload,
							),
						);
						if (migrated._tag === 'Failure') {
							yield* store.quarantineMigration(
								claim.token,
								migrated.failure instanceof VersionedSchemaError
									? migrated.failure.reason
									: 'InvalidPayload',
								yield* DateTime.now,
							);
							return yield* store.get(claim.record.id);
						}
						const beforePromotion = yield* store.get(claim.record.id);
						if (beforePromotion?.status === 'cancelled') return beforePromotion;
						const running = yield* store.promoteToRunning(
							claim.token,
							migrated.success,
							declaration.payload.latest.version,
							yield* DateTime.now,
							leaseDuration,
						);
						if (running.cancellationRequested) {
							yield* store.finalize(
								claim.token,
								JobOutcome.cancelled,
								yield* DateTime.now,
							);
							return yield* store.get(running.id);
						}
						const execution = Effect.provide(
							implementation.handler(migrated.success),
							infrastructure,
						) as Effect.Effect<void, any, never>;
						const monitor: Effect.Effect<
							never,
							CancelSignal | LeaseSignal | JobStoreError
						> = Effect.suspend(() =>
							Effect.flatMap(Effect.sleep(heartbeatInterval), () =>
								Effect.gen(function* () {
									const current = yield* store.get(running.id);
									if (current?.cancellationRequested)
										return yield* Effect.fail(new CancelSignal());
									const heartbeatNow = yield* DateTime.now;
									if (
										!(yield* store.heartbeat(
											claim.token,
											heartbeatNow,
											leaseDuration,
										))
									)
										return yield* Effect.fail(new LeaseSignal());
									return yield* monitor;
								}),
							),
						);
						const exit = yield* Effect.exit(
							Effect.raceFirst(execution, monitor),
						);
						if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
							return yield* Effect.failCause(exit.cause);
						const finishedAt = yield* DateTime.now;
						const afterExecution = yield* store.get(running.id);
						if (afterExecution?.cancellationRequested) {
							yield* store.finalize(
								claim.token,
								JobOutcome.cancelled,
								finishedAt,
							);
							return yield* store.get(running.id);
						}
						if (Exit.isSuccess(exit))
							yield* store.finalize(
								claim.token,
								JobOutcome.succeeded,
								finishedAt,
							);
						else {
							const failure = Cause.findErrorOption(exit.cause);
							if (
								Option.isSome(failure) &&
								failure.value instanceof CancelSignal
							) {
								yield* store.finalize(
									claim.token,
									JobOutcome.cancelled,
									finishedAt,
								);
								return yield* store.get(running.id);
							}
							if (
								Option.isSome(failure) &&
								failure.value instanceof LeaseSignal
							)
								return yield* store.get(running.id);
							if (
								Option.isSome(failure) &&
								failure.value instanceof JobStoreError
							)
								return yield* Effect.fail(failure.value);
							if (Option.isSome(failure)) {
								const encoded = yield* Effect.result(
									Effect.try(() =>
										Schema.encodeSync(declaration.error)(failure.value),
									),
								);
								if (encoded._tag === 'Failure') {
									yield* store.finalize(
										claim.token,
										JobOutcome.fatalFailure('Invalid job error encoding'),
										finishedAt,
									);
									return yield* store.get(running.id);
								}
								let decision: Job.RetryDecision | undefined;
								try {
									decision = declaration.retry(failure.value);
								} catch {
									yield* store.finalize(
										claim.token,
										JobOutcome.fatalFailure('Invalid retry policy'),
										finishedAt,
									);
									return yield* store.get(running.id);
								}
								if (decision?._tag === 'Retry') {
									let retryAfter: Duration.Duration;
									try {
										retryAfter =
											decision.retryAfter ??
											declaration.schedule(running.attempts);
									} catch {
										yield* store.finalize(
											claim.token,
											JobOutcome.fatalFailure('Invalid retry policy'),
											finishedAt,
										);
										return yield* store.get(running.id);
									}
									const retryAt = DateTime.addDuration(finishedAt, retryAfter);
									if (
										!Duration.isFinite(retryAfter) ||
										Duration.isNegative(retryAfter) ||
										!Number.isFinite(DateTime.toDateUtc(retryAt).getTime())
									) {
										yield* store.finalize(
											claim.token,
											JobOutcome.fatalFailure('Invalid retry policy'),
											finishedAt,
										);
										return yield* store.get(running.id);
									}
									yield* store.finalize(
										claim.token,
										JobOutcome.retryableFailure(encoded.success, retryAfter),
										finishedAt,
										retryAt,
									);
								} else
									yield* store.finalize(
										claim.token,
										JobOutcome.permanentFailure(encoded.success),
										finishedAt,
									);
							} else
								yield* store.finalize(
									claim.token,
									JobOutcome.fatalFailure('Job execution defect'),
									finishedAt,
								);
						}
						return yield* store.get(running.id);
					}),
				cancel: (id) =>
					Effect.flatMap(DateTime.now, (now) => store.cancel(id, now)),
				releaseFailed: (id, options) =>
					Effect.gen(function* () {
						const record = yield* store.get(id);
						if (record === undefined)
							return yield* Effect.fail(
								new JobStoreError('NotFound', 'Unknown job'),
							);
						const implementation = byName.get(record.name);
						if (implementation === undefined)
							return yield* Effect.fail(
								new JobStoreError('InvalidState', 'Unknown job declaration'),
							);
						const validation = yield* Effect.result(
							implementation.declaration.payload.migrate(
								record.payloadVersion,
								record.payload,
							),
						);
						if (validation._tag === 'Failure')
							return yield* Effect.fail(
								new JobStoreError(
									'InvalidState',
									'Job payload cannot be released',
								),
							);
						const now = yield* DateTime.now;
						return yield* store.releaseFailed(id, now, options);
					}),
			};
			return service;
		}),
	);
