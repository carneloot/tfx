import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { ConversationStorage } from '../../tfx/src/ConversationStorage.js';
import { conversationStorageConformance } from '../../tfx/test/internal/ConversationStorageConformance.js';
import * as PostgresConversationStorage from '../src/PostgresConversationStorage.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = () =>
	Layer.provide(
		PostgresConversationStorage.layer({
			schema: 'tfx_conversation_test',
			tablePrefix: 'case_',
		}),
		PostgresTestLayer.layer,
	);
const row = (
	scope: { botId: string; chatId: number; userId: number },
	id: string,
) => ({
	scope,
	conversationId: id,
	version: 1,
	step: 'one',
	state: 0,
	lastUpdateId: undefined,
	expiresAt: undefined,
});
if (!enabled)
	describe.skip('PostgreSQL conversation conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else {
	conversationStorageConformance('postgres', layer);
	describe('PostgreSQL conversation coordination', () => {
		it('allows one winner for concurrent fail-policy creation', async () => {
			const scope = { botId: crypto.randomUUID(), chatId: 10, userId: 20 };
			const program = Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				return yield* Effect.all(
					[
						Effect.result(storage.create(row(scope, 'first'), 'fail')),
						Effect.result(storage.create(row(scope, 'second'), 'fail')),
					],
					{ concurrency: 'unbounded' },
				);
			});
			const results = await Effect.runPromise(Effect.provide(program, layer()));
			expect(
				results.filter((result) => result._tag === 'Success'),
			).toHaveLength(1);
			const failure = results.find((result) => result._tag === 'Failure');
			expect(failure).toMatchObject({ failure: { reason: 'Conflict' } });
		});

		it('rolls back an interrupted transition and releases its row lock', async () => {
			const scope = { botId: crypto.randomUUID(), chatId: 11, userId: 21 };
			const program = Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				yield* storage.create(row(scope, 'flow'), 'fail');
				const started = yield* Deferred.make<void>();
				const blocked = yield* Effect.forkChild(
					storage.transition(scope, 1, 0, () =>
						Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
					),
				);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(blocked);
				return yield* storage.transition(scope, 2, 0, () =>
					Effect.succeed({
						value: undefined,
						mutation: { _tag: 'Persist' as const, step: 'two', state: 1 },
					}),
				);
			});
			const result = await Effect.runPromise(Effect.provide(program, layer()));
			expect(result).toMatchObject({ _tag: 'Applied', row: { revision: 1 } });
		});
	});
}
