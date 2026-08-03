import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
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
type RetryEvaluation =
	| {
			readonly _tag: 'Retry';
			readonly delay: Duration.Duration;
			readonly retryAt: DateTime.Utc;
	  }
	| { readonly _tag: 'Permanent' };
const validRetryDuration = (value: Duration.Duration): boolean =>
	Duration.isFinite(value) && !Duration.isNegative(value);
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
): Layer.Layer<JobRuntime, never, JobStore | Requirements<I>> => {
	const names = new Set<string>();
	for (const implementation of implementations) {
		const name = implementation.declaration.name;
		if (names.has(name))
			throw new TypeError(`Duplicate job declaration '${name}'`);
		names.add(name);
	}
	return Layer.effect(
		JobRuntime,
		Effect.gen(function* () {
			const store = yield* JobStore;
			const infrastructure = yield* Effect.context<Requirements<I>>();
			const byName = new Map(
				implementations.map((i) => [i.declaration.name, i]),
			);
			const logRunResult = (record: JobRecord | undefined) => {
				if (record === undefined) return Effect.void;
				const annotations = {
					jobId: record.id,
					jobName: record.name,
					status: record.status,
					attempts: record.attempts,
				};
				switch (record.status) {
					case 'completed':
					case 'cancelled':
						return Effect.logInfo('tfx.job.run_finished').pipe(
							Effect.annotateLogs(annotations),
						);
					case 'scheduled':
					case 'running':
						return Effect.logWarning('tfx.job.run_finished').pipe(
							Effect.annotateLogs(annotations),
						);
					case 'failed':
					case 'quarantined':
						return Effect.logError('tfx.job.run_finished').pipe(
							Effect.annotateLogs(annotations),
						);
				}
			};
			const getLogged = Effect.fn('JobRuntime.getLogged')(function* (
				id: string,
			) {
				const record = yield* store.get(id);
				yield* logRunResult(record);
				return record;
			});
			const service: JobRuntimeService = {
				problems: store.problems(),
				schedule: Effect.fn('JobRuntime.schedule')(function* (
					job,
					payload,
					options = {},
				) {
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
					yield* Effect.logInfo('tfx.job.scheduled').pipe(
						Effect.annotateLogs({
							jobId: result.record.id,
							jobName: result.record.name,
							replaced: result.replacedId !== undefined,
						}),
					);
					return {
						id: result.record.id,
						...(result.replacedId === undefined
							? {}
							: { replacedId: result.replacedId }),
					};
				}),
				runOne: Effect.fnUntraced(function* (options = {}) {
					const leaseDuration = Option.getOrElse(
						Duration.fromInput(options.leaseDuration ?? Duration.seconds(30)),
						() => Duration.infinity,
					);
					const heartbeatInterval = Option.getOrElse(
						Duration.fromInput(
							options.heartbeatInterval ??
								Duration.millis(
									Math.max(1, Math.floor(Duration.toMillis(leaseDuration) / 3)),
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
					const claim = yield* store
						.claimForMigration(claimNow, leaseDuration)
						.pipe(Effect.withTracerEnabled(false));
					if (claim === undefined) return undefined;
					return yield* Effect.gen(function* () {
						yield* Effect.logInfo('tfx.job.claimed').pipe(
							Effect.annotateLogs({
								jobId: claim.record.id,
								jobName: claim.record.name,
								attempts: claim.record.attempts,
							}),
						);
						const implementation = byName.get(claim.record.name);
						if (implementation === undefined) {
							yield* store.quarantineMigration(
								claim.token,
								'UnknownDeclaration',
								yield* DateTime.now,
							);
							return yield* getLogged(claim.record.id);
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
							return yield* getLogged(claim.record.id);
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
							return yield* getLogged(claim.record.id);
						}
						const beforePromotion = yield* store.get(claim.record.id);
						if (beforePromotion?.status === 'cancelled') {
							yield* logRunResult(beforePromotion);
							return beforePromotion;
						}
						const running = yield* store.promoteToRunning(
							claim.token,
							migrated.success,
							declaration.payload.latest.version,
							yield* DateTime.now,
							leaseDuration,
						);
						yield* Effect.logInfo('tfx.job.running').pipe(
							Effect.annotateLogs({
								jobId: running.id,
								jobName: running.name,
								attempts: running.attempts,
							}),
						);
						if (running.cancellationRequested) {
							yield* store.finalize(
								claim.token,
								JobOutcome.cancelled,
								yield* DateTime.now,
							);
							return yield* getLogged(running.id);
						}
						const execution = Effect.provide(
							implementation.handler(migrated.success),
							infrastructure,
						) as Effect.Effect<void, any, never>;
						const heartbeat = Effect.gen(function* () {
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
						});
						const monitor: Effect.Effect<
							never,
							CancelSignal | LeaseSignal | JobStoreError
						> = heartbeat.pipe(
							Effect.repeat(Schedule.spaced(heartbeatInterval)),
							Effect.delay(heartbeatInterval),
							Effect.andThen(Effect.never),
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
							return yield* getLogged(running.id);
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
								return yield* getLogged(running.id);
							}
							if (
								Option.isSome(failure) &&
								failure.value instanceof LeaseSignal
							)
								return yield* getLogged(running.id);
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
									return yield* getLogged(running.id);
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
									return yield* getLogged(running.id);
								}
								let evaluation: RetryEvaluation;
								try {
									if (decision === undefined || decision._tag === 'Permanent')
										evaluation = { _tag: 'Permanent' };
									else if (decision._tag === 'Retry') {
										const delay =
											decision.retryAfter ??
											declaration.schedule(running.attempts);
										const retryAt = DateTime.addDuration(finishedAt, delay);
										if (
											!validRetryDuration(delay) ||
											!Number.isFinite(DateTime.toDateUtc(retryAt).getTime())
										)
											throw new TypeError(
												'Job retry delay must produce a valid instant',
											);
										evaluation = { _tag: 'Retry', delay, retryAt };
									} else throw new TypeError('Invalid job retry decision');
								} catch {
									yield* store.finalize(
										claim.token,
										JobOutcome.fatalFailure('Invalid retry policy'),
										finishedAt,
									);
									return yield* getLogged(running.id);
								}
								if (evaluation._tag === 'Retry') {
									yield* store.finalize(
										claim.token,
										JobOutcome.retryableFailure(
											encoded.success,
											evaluation.delay,
										),
										finishedAt,
										evaluation.retryAt,
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
						return yield* getLogged(running.id);
					}).pipe(
						Effect.withSpan('JobRuntime.job-execution', {
							attributes: {
								jobId: claim.record.id,
								jobName: claim.record.name,
							},
						}),
					);
				}),
				cancel: Effect.fn('JobRuntime.cancel')(function* (id) {
					const cancelled = yield* Effect.flatMap(DateTime.now, (now) =>
						store.cancel(id, now),
					);
					if (cancelled)
						yield* Effect.logInfo('tfx.job.cancellation_requested').pipe(
							Effect.annotateLogs({ jobId: id }),
						);
					return cancelled;
				}),
				releaseFailed: Effect.fn('JobRuntime.releaseFailed')(
					function* (id, options) {
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
					},
				),
			};
			return service;
		}),
	);
};
