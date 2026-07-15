import { Effect, Layer } from 'effect';
import {
	Bot,
	BotRuntime,
	DispatchOutcome,
	UpdateDeduplicator,
	UpdateDelivery,
} from 'tfx';
import { describe, expect, it } from 'vitest';

import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import { UpdateSource } from '../src/internal/update-source/UpdateSource.js';
describe('BotRuntime', () => {
	it('installs one delivery and requires explicit deduplication', async () => {
		const delivery = UpdateDelivery.make({
			id: 'test',
			layer: Layer.succeed(UpdateSource, { run: () => Effect.void }),
		});
		const runtime = BotRuntime.layer(Bot.make('bot'), {
			delivery,
			concurrency: 1,
			capacity: 1,
		});
		const program = Effect.flatMap(BotRuntime.BotRuntime, (service) =>
			service.dispatch({ update_id: 1 } as Update),
		);
		const outcome = await Effect.runPromise(
			Effect.provide(
				program,
				Layer.provide(runtime, UpdateDeduplicator.layerNoop),
			),
		);
		expect(outcome).toEqual({ _tag: 'Handled' });
	});
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
