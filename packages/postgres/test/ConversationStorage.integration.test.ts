import * as PgClient from '@effect/sql-pg/PgClient';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { ConversationStorage } from '../../tfx/src/ConversationStorage.js';
import { conversationStorageConformance } from '../../tfx/test/internal/ConversationStorageConformance.js';
import { migrate } from '../src/Migrations.js';
import * as PostgresConversationStorage from '../src/PostgresConversationStorage.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const options = {
	schema: 'tfx_conversation_test',
	tablePrefix: 'case_',
};
const adapter = Layer.unwrap(
	Effect.as(migrate(options), PostgresConversationStorage.layer(options)),
);
const layer = () => Layer.provide(adapter, PostgresTestLayer.layer);
const diagnosticLayer = Layer.provideMerge(adapter, PostgresTestLayer.layer);
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
				const readyA = yield* Deferred.make<void>();
				const readyB = yield* Deferred.make<void>();
				const go = yield* Deferred.make<void>();
				const create = (ready: Deferred.Deferred<void>, id: string) =>
					Effect.andThen(
						Deferred.succeed(ready, undefined),
						Effect.andThen(
							Deferred.await(go),
							Effect.result(storage.create(row(scope, id), 'fail')),
						),
					);
				const a = yield* Effect.forkChild(create(readyA, 'first'));
				const b = yield* Effect.forkChild(create(readyB, 'second'));
				yield* Deferred.await(readyA);
				yield* Deferred.await(readyB);
				yield* Deferred.succeed(go, undefined);
				return yield* Effect.all([Fiber.join(a), Fiber.join(b)], {
					concurrency: 'unbounded',
				});
			});
			const results = await Effect.runPromise(Effect.provide(program, layer()));
			expect(
				results.filter((result) => result._tag === 'Success'),
			).toHaveLength(1);
			const failure = results.find((result) => result._tag === 'Failure');
			expect(failure).toMatchObject({ failure: { reason: 'Conflict' } });
		});

		it('rejects unsafe persisted conversation integers as invariants', async () => {
			const scope = { botId: crypto.randomUUID(), chatId: 13, userId: 23 };
			const program = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const storage = yield* ConversationStorage;
				yield* sql`INSERT INTO tfx_conversation_test.case_conversations (bot_id,chat_id,user_id,conversation_id,version,step,state_json,revision) VALUES (${scope.botId},${scope.chatId},${scope.userId},'unsafe',1,'one','{}'::jsonb,9007199254740992)`;
				const result = yield* Effect.result(storage.load(scope));
				yield* sql`DELETE FROM tfx_conversation_test.case_conversations WHERE bot_id=${scope.botId}`;
				return result;
			});
			const result = await Effect.runPromise(
				Effect.provide(program, diagnosticLayer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { reason: 'InvariantViolation' },
			});
		});

		it('preserves arbitrary handler errors and leaves the row unchanged', async () => {
			const scope = { botId: crypto.randomUUID(), chatId: 12, userId: 22 };
			const sentinel = { _tag: 'UniqueHandlerFailure' as const };
			const program = Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				yield* storage.create(row(scope, 'flow'), 'fail');
				const result = yield* Effect.result(
					storage.transition(scope, 1, 0, () => Effect.fail(sentinel)),
				);
				return { result, stored: yield* storage.load(scope) };
			});
			const result = await Effect.runPromise(Effect.provide(program, layer()));
			expect(result.result._tag).toBe('Failure');
			if (result.result._tag === 'Failure')
				expect(result.result.failure).toBe(sentinel);
			expect(result.stored).toMatchObject({ revision: 0, state: 0 });
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
