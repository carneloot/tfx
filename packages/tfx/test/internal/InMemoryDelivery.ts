import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';

import type { DispatchOutcome } from '../../src/DispatchOutcome.js';
import type { Update } from '../../src/internal/telegram/generated/TelegramApi.types.js';
import { UpdateSource } from '../../src/internal/update-source/UpdateSource.js';
import * as UpdateDelivery from '../../src/UpdateDelivery.js';
export interface InMemoryDelivery {
	readonly delivery: UpdateDelivery.UpdateDelivery<'test-memory', never, never>;
	readonly offer: (update: Update) => Effect.Effect<void>;
	readonly awaitOutcome: (updateId: number) => Effect.Effect<DispatchOutcome>;
	readonly close: Effect.Effect<void>;
}
export const make = (capacity = 16): Effect.Effect<InMemoryDelivery> =>
	Effect.gen(function* () {
		const queue = yield* Queue.bounded<Update>(capacity);
		const outcomes = yield* Ref.make(
			new Map<number, Deferred.Deferred<DispatchOutcome>>(),
		);
		const semaphore = yield* Semaphore.make(1);
		const deferred = (id: number) =>
			semaphore.withPermit(
				Effect.gen(function* () {
					const values = yield* Ref.get(outcomes);
					const existing = values.get(id);
					if (existing !== undefined) return existing;
					const created = yield* Deferred.make<DispatchOutcome>();
					const next = new Map(values);
					next.set(id, created);
					yield* Ref.set(outcomes, next);
					return created;
				}),
			);
		const source = {
			run: (
				deliver: (update: Update) => Effect.Effect<DispatchOutcome, never>,
			) =>
				Stream.runForEach(Stream.fromQueue(queue), (update) =>
					Effect.flatMap(deliver(update), (outcome) =>
						Effect.flatMap(deferred(update.update_id), (result) =>
							Effect.asVoid(Deferred.succeed(result, outcome)),
						),
					),
				),
		};
		return {
			delivery: UpdateDelivery.make({
				id: 'test-memory',
				layer: Layer.succeed(UpdateSource, source),
			}),
			offer: (update) =>
				Effect.andThen(deferred(update.update_id), Queue.offer(queue, update)),
			awaitOutcome: (id) => Effect.flatMap(deferred(id), Deferred.await),
			close: Effect.asVoid(Queue.shutdown(queue)),
		};
	});
