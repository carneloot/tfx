import { Deferred, Effect, Layer, Ref } from 'effect';
import {
	Bot,
	BotRuntime,
	DispatchOutcome,
	MemoryUpdateDeduplicator,
	UpdateDeduplicator,
	UpdateDelivery,
} from 'tfx';
import { describe, expect, it } from 'vitest';

const update = (id: number) => ({ update_id: id }) as never;
const runtime = (delivery: UpdateDelivery.UpdateDelivery<any, any, never>) =>
	Layer.provide(
		BotRuntime.layer(Bot.make('bot'), {
			delivery,
			concurrency: 1,
			capacity: 4,
		}),
		UpdateDeduplicator.layerNoop,
	);

describe('BotRuntime', () => {
	it('supports public manual delivery and direct dispatch', async () => {
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(runtime(UpdateDelivery.manual));
					return yield* Effect.provide(
						Effect.flatMap(BotRuntime.BotRuntime, (service) =>
							service.dispatch(update(1)),
						),
						context,
					);
				}),
			),
		);
		expect(outcome).toEqual({ _tag: 'Handled' });
	});

	it('deduplicates direct public dispatch with configured timings', async () => {
		let calls = 0;
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						Layer.provide(
							BotRuntime.layer(Bot.make('bot'), {
								delivery: UpdateDelivery.manual,
								leaseDuration: 100,
								waitTimeout: 100,
								retention: 1_000,
								router: {
									route: () =>
										Effect.sync(() => {
											calls++;
											return DispatchOutcome.handled;
										}),
								},
							}),
							MemoryUpdateDeduplicator.layerMemory,
						),
					);
					return yield* Effect.provide(
						Effect.gen(function* () {
							const service = yield* BotRuntime.BotRuntime;
							const first = yield* service.dispatch(update(50));
							const second = yield* service.dispatch(update(50));
							return [first, second];
						}),
						context,
					);
				}),
			),
		);
		expect(outcome).toEqual([DispatchOutcome.handled, DispatchOutcome.handled]);
		expect(calls).toBe(1);
	});

	it('observes successful source termination', async () => {
		const delivery = UpdateDelivery.fromSource('success', () => Effect.void);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(runtime(delivery));
					yield* Effect.provide(
						Effect.flatMap(BotRuntime.BotRuntime, (service) => service.await),
						context,
					);
				}),
			),
		);
	});

	it('observes immediate and delayed source failures', async () => {
		for (const delayed of [false, true]) {
			const gate = Deferred.makeUnsafe<void>();
			const delivery = UpdateDelivery.fromSource('failure', () =>
				Effect.andThen(
					delayed ? Deferred.await(gate) : Effect.void,
					Effect.fail('source failed'),
				),
			);
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(runtime(delivery));
						if (delayed) yield* Deferred.succeed(gate, undefined);
						return yield* Effect.provide(
							Effect.flatMap(BotRuntime.BotRuntime, (service) =>
								Effect.result(service.await),
							),
							context,
						);
					}),
				),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: 'source failed',
			});
		}
	});

	it('interrupts source and runs its finalizer on scope shutdown', async () => {
		const finalized = Ref.makeUnsafe(false);
		const started = Deferred.makeUnsafe<void>();
		const delivery = UpdateDelivery.fromSource('scoped', () =>
			Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
				Effect.ensuring(Ref.set(finalized, true)),
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Layer.build(runtime(delivery));
					yield* Deferred.await(started);
				}),
			),
		);
		expect(Ref.getUnsafe(finalized)).toBe(true);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid dedup duration %s',
		async (leaseDuration) => {
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Layer.build(
						Layer.provide(
							BotRuntime.layer(Bot.make('bot'), {
								delivery: UpdateDelivery.manual,
								leaseDuration,
							}),
							UpdateDeduplicator.layerNoop,
						),
					),
				),
			);
			expect(exit._tag).toBe('Failure');
		},
	);

	it('acknowledges only closed completed outcomes and marks fatal terminal', () => {
		expect(DispatchOutcome.isAcknowledgeable(DispatchOutcome.handled)).toBe(
			true,
		);
		expect(
			DispatchOutcome.isAcknowledgeable(
				DispatchOutcome.handledWithOutputFailure('x'),
			),
		).toBe(true);
		expect(
			DispatchOutcome.isAcknowledgeable(DispatchOutcome.permanentInvalid('x')),
		).toBe(true);
		expect(
			DispatchOutcome.isAcknowledgeable(DispatchOutcome.retryableFailure('x')),
		).toBe(false);
		expect(DispatchOutcome.isTerminal(DispatchOutcome.fatal('x'))).toBe(true);
	});
});
