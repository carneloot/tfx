import { Deferred, Duration, Effect, Layer, Random, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { JobRuntime, type JobRuntimeService } from 'tfx/JobRuntime';
import { JobStoreError } from 'tfx/JobStore';
import { describe, expect, it } from 'vitest';

import { JobWorker } from '../src/JobWorker.js';
import * as JobWorkerLive from '../src/JobWorker.js';
import { NotificationRepository } from '../src/ports/NotificationRepository.js';

const runtime = (
	runOne: JobRuntimeService['runOne'],
	problems = Effect.succeed([]),
) =>
	Layer.succeed(JobRuntime, {
		schedule: () => Effect.die('unused'),
		runOne,
		problems,
		cancel: () => Effect.die('unused'),
		releaseFailed: () => Effect.die('unused'),
	});
const notifications = (recovered: number) =>
	Layer.succeed(NotificationRepository, {
		recoverAllExpired: () => Effect.succeed(recovered),
	} as never);
const worker = (
	jobs: Layer.Layer<JobRuntime>,
	recovered = 0,
	idleDelay: Duration.Input = '100 millis',
) =>
	Layer.provide(
		JobWorkerLive.layer({
			idleDelay,
			leaseDuration: '300 millis',
			heartbeatInterval: '100 millis',
		}),
		Layer.merge(jobs, notifications(recovered)),
	);

describe('JobWorker', () => {
	it('recovers first, reports problems, drains immediately, then idles', async () => {
		let calls = 0;
		const idle = Deferred.makeUnsafe<void>();
		const problem = { id: 'problem', status: 'quarantined' } as never;
		const jobs = runtime(
			() =>
				Effect.sync(() => {
					calls++;
					return calls <= 2 ? ({ id: String(calls) } as never) : undefined;
				}).pipe(
					Effect.tap((record) =>
						record === undefined
							? Deferred.succeed(idle, undefined)
							: Effect.void,
					),
				),
			Effect.succeed([problem]),
		);
		const clock = TestClock.layer();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						Layer.merge(Layer.provide(worker(jobs, 4), clock), clock),
					);
					yield* Deferred.await(idle);
					const service = yield* Effect.provide(JobWorker, context);
					expect(service.diagnostics).toEqual({
						recoveredDeliveries: 4,
						startupProblems: [problem],
						failedJobIds: [],
						quarantinedJobIds: ['problem'],
					});
					expect(calls).toBe(3);
					yield* Effect.provide(TestClock.adjust(99), context);
					expect(calls).toBe(3);
					yield* Effect.provide(TestClock.adjust(1), context);
					expect(calls).toBe(4);
				}),
			),
		);
	});

	it('interrupts an active runOne when worker scope closes', async () => {
		const started = Deferred.makeUnsafe<void>();
		const interrupted = Ref.makeUnsafe(false);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Layer.build(
						worker(
							runtime(() =>
								Effect.andThen(
									Deferred.succeed(started, undefined),
									Effect.never,
								).pipe(Effect.ensuring(Ref.set(interrupted, true))),
							),
						),
					);
					yield* Deferred.await(started);
				}),
			),
		);
		expect(Ref.getUnsafe(interrupted)).toBe(true);
	});

	it('recovers after a bounded burst of persistence failures', async () => {
		let calls = 0;
		const started = Deferred.makeUnsafe<void>();
		const recovered = Deferred.makeUnsafe<void>();
		const clock = TestClock.layer();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						Layer.merge(
							Layer.provide(
								worker(
									runtime(() => {
										calls++;
										const result =
											calls <= 6
												? Effect.fail(
														new JobStoreError(
															'PersistenceFailure',
															'store failed',
														),
													)
												: Effect.andThen(
														Deferred.succeed(recovered, undefined),
														Effect.never,
													);
										return Effect.andThen(
											Deferred.succeed(started, undefined),
											result,
										);
									}),
									0,
									'1 milli',
								),
								clock,
							),
							clock,
						),
					);
					yield* Deferred.await(started);
					yield* Effect.provide(TestClock.adjust('10 seconds'), context);
					yield* Deferred.await(recovered);
					expect(calls).toBe(7);
				}),
			).pipe(Random.withSeed('job-worker-recovery')),
		);
	});

	it('surfaces invariant violations through await', async () => {
		const contextProgram = Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					worker(
						runtime(() =>
							Effect.fail(
								new JobStoreError('InvariantViolation', 'invalid state'),
							),
						),
					),
				);
				return yield* Effect.provide(
					Effect.flatMap(JobWorker, (service) => Effect.result(service.await)),
					context,
				);
			}),
		);
		expect(await Effect.runPromise(contextProgram)).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'JobStoreError', reason: 'InvariantViolation' },
		});
	});

	it('accepts normalized Effect durations', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				Layer.build(
					Layer.provide(
						JobWorkerLive.layer({
							idleDelay: Duration.millis(100),
							leaseDuration: Duration.seconds(2),
							heartbeatInterval: Duration.seconds(1),
						}),
						Layer.merge(
							runtime(() => Effect.never),
							notifications(0),
						),
					),
				),
			),
		);
		expect(exit._tag).toBe('Success');
	});

	it.each(['idleDelay', 'leaseDuration', 'heartbeatInterval'] as const)(
		'rejects invalid %s values',
		async (option) => {
			for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
				const values = {
					idleDelay: Duration.seconds(1),
					leaseDuration: Duration.seconds(2),
					heartbeatInterval: Duration.seconds(1),
					[option]: invalid,
				};
				const error = await Effect.runPromise(
					Effect.flip(
						Effect.scoped(
							Layer.build(
								Layer.provide(
									JobWorkerLive.layer(values),
									Layer.merge(
										runtime(() => Effect.never),
										notifications(0),
									),
								),
							),
						),
					),
				);
				expect(error).toMatchObject({
					_tag: 'JobWorkerOptionsError',
					option,
				});
			}
		},
	);
});
