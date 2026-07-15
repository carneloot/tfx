import { Deferred, Effect, Layer, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { JobRuntime, type JobRuntimeService } from 'tfx/JobRuntime';
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
const worker = (jobs: Layer.Layer<JobRuntime>, recovered = 0) =>
	Layer.provide(
		JobWorkerLive.layer({
			idleDelay: 100,
			leaseDuration: 300,
			heartbeatInterval: 100,
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

	it('surfaces loop failure through await', async () => {
		const contextProgram = Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					worker(runtime(() => Effect.fail('store failed'))),
				);
				return yield* Effect.provide(
					Effect.flatMap(JobWorker, (service) => Effect.result(service.await)),
					context,
				);
			}),
		);
		expect(await Effect.runPromise(contextProgram)).toMatchObject({
			_tag: 'Failure',
			failure: 'store failed',
		});
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid idle delay %s',
		async (idleDelay) => {
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Layer.build(
						Layer.provide(
							JobWorkerLive.layer({
								idleDelay,
								leaseDuration: 2,
								heartbeatInterval: 1,
							}),
							Layer.merge(
								runtime(() => Effect.never),
								notifications(0),
							),
						),
					),
				),
			);
			expect(exit._tag).toBe('Failure');
		},
	);
});
