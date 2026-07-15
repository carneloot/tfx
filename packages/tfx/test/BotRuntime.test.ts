import { Deferred, Effect, Layer, Ref } from 'effect';
import {
	Bot,
	BotRuntime,
	DispatchOutcome,
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
