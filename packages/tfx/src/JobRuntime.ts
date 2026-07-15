import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';

import * as Job from './Job.js';
import * as JobOutcome from './JobOutcome.js';
import { JobStore, JobStoreError, type JobRecord } from './JobStore.js';
import { VersionedSchemaError } from './VersionedSchema.js';
export interface JobRuntimeService {
	readonly schedule: <J extends Job.Job<any, any, any>>(
		job: J,
		payload: Job.Payload<J>,
		options?: { readonly runAt?: number; readonly conflictKey?: string },
	) => Effect.Effect<{ readonly id: string; readonly replacedId?: string }>;
	readonly runOne: (options?: {
		readonly leaseDuration?: number;
	}) => Effect.Effect<JobRecord | undefined, unknown>;
	readonly cancel: (id: string) => Effect.Effect<boolean>;
	readonly releaseFailed: (
		id: string,
		options: { readonly reason: string; readonly resetAttempts?: boolean },
	) => Effect.Effect<JobRecord, unknown>;
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
				schedule: (job, payload, options = {}) =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
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
						const now = yield* Clock.currentTimeMillis;
						const leaseDuration = options.leaseDuration ?? 30_000;
						const claim = yield* store.claimForMigration(now, leaseDuration);
						if (claim === undefined) return undefined;
						const implementation = byName.get(claim.record.name);
						if (implementation === undefined) {
							yield* store.quarantineMigration(
								claim.token,
								'UnknownDeclaration',
								now,
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
								now,
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
								now,
							);
							return yield* store.get(claim.record.id);
						}
						const beforePromotion = yield* store.get(claim.record.id);
						if (beforePromotion?.status === 'cancelled') return beforePromotion;
						const running = yield* store.promoteToRunning(
							claim.token,
							migrated.success,
							declaration.payload.latest.version,
							now,
							leaseDuration,
						);
						if (running.cancellationRequested) {
							yield* store.finalize(claim.token, JobOutcome.cancelled, now);
							return yield* store.get(running.id);
						}
						const execution = Effect.provide(
							implementation.handler(migrated.success),
							infrastructure,
						) as Effect.Effect<void, any, never>;
						const monitor: Effect.Effect<never, CancelSignal | LeaseSignal> =
							Effect.suspend(() =>
								Effect.flatMap(
									Effect.sleep(Math.max(1, Math.floor(leaseDuration / 3))),
									() =>
										Effect.gen(function* () {
											const current = yield* store.get(running.id);
											if (current?.cancellationRequested)
												return yield* Effect.fail(new CancelSignal());
											const heartbeatNow = yield* Clock.currentTimeMillis;
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
						const finishedAt = yield* Clock.currentTimeMillis;
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
							if (Option.isSome(failure)) {
								const decision = declaration.retry(failure.value);
								if (decision?._tag === 'Retry') {
									const retryAfter =
										decision.retryAfter ??
										declaration.schedule(running.attempts);
									yield* store.finalize(
										claim.token,
										JobOutcome.retryableFailure(failure.value, retryAfter),
										finishedAt,
										finishedAt + retryAfter,
									);
								} else
									yield* store.finalize(
										claim.token,
										JobOutcome.permanentFailure(failure.value),
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
					Effect.flatMap(Clock.currentTimeMillis, (now) =>
						store.cancel(id, now),
					),
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
						const now = yield* Clock.currentTimeMillis;
						return yield* store.releaseFailed(id, now, options);
					}),
			};
			return service;
		}),
	);
