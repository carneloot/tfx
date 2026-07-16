import { Deferred, Effect } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import { ConversationStorage } from '../src/ConversationStorage.js';
import * as MemoryConversationStorage from '../src/MemoryConversationStorage.js';

const scope = { botId: 'bot', chatId: 1, userId: 2 };
const run = <A, E>(effect: Effect.Effect<A, E, ConversationStorage>) =>
	Effect.runPromise(Effect.provide(effect, MemoryConversationStorage.layer));

describe('MemoryConversationStorage', () => {
	it('enforces conflict, revision, duplicate replay, and completion', async () => {
		await run(
			Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				const row = yield* storage.create(
					{
						scope,
						conversationId: 'flow',
						version: 1,
						step: 'one',
						state: 0,
						lastUpdateId: undefined,
						expiresAt: undefined,
					},
					'fail',
				);
				yield* Effect.flip(
					storage.create({ ...row, lastUpdateId: undefined }, 'fail'),
				);
				let runs = 0;
				const applied = yield* storage.transition(scope, 10, 0, () =>
					Effect.sync(() => ({
						value: ++runs,
						mutation: { _tag: 'Persist' as const, step: 'one', state: 1 },
					})),
				);
				expect(applied._tag).toBe('Applied');
				const duplicate = yield* storage.transition(scope, 10, 1, () =>
					Effect.sync(() => ({
						value: ++runs,
						mutation: { _tag: 'Delete' as const },
					})),
				);
				expect(duplicate._tag).toBe('Duplicate');
				expect(runs).toBe(1);
				const completed = yield* storage.transition(scope, 11, 1, () =>
					Effect.succeed({
						value: undefined,
						mutation: { _tag: 'Delete' as const },
					}),
				);
				expect(completed._tag).toBe('Applied');
				expect(yield* storage.load(scope)).toBeUndefined();
			}),
		);
	});

	it('serializes concurrent optimistic transitions', async () => {
		await run(
			Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				yield* storage.create(
					{
						scope,
						conversationId: 'flow',
						version: 1,
						step: 'one',
						state: 0,
						lastUpdateId: undefined,
						expiresAt: undefined,
					},
					'fail',
				);
				let runs = 0;
				const results = yield* Effect.all(
					Array.from({ length: 8 }, (_, i) =>
						storage.transition(scope, i + 1, 0, () =>
							Effect.sync(() => ({
								value: ++runs,
								mutation: { _tag: 'Persist' as const, step: 'one', state: 1 },
							})),
						),
					),
					{ concurrency: 'unbounded' },
				);
				expect(results.filter((r) => r._tag === 'Applied')).toHaveLength(1);
				expect(runs).toBe(1);
			}),
		);
	});

	it('uses independent permits for different conversation scopes', async () => {
		await run(
			Effect.gen(function* () {
				const storage = yield* ConversationStorage;
				const other = { ...scope, chatId: 2 };
				for (const current of [scope, other])
					yield* storage.create(
						{
							scope: current,
							conversationId: 'flow',
							version: 1,
							step: 'one',
							state: 0,
							lastUpdateId: undefined,
							expiresAt: undefined,
						},
						'fail',
					);
				const firstStarted = yield* Deferred.make<void>();
				const secondStarted = yield* Deferred.make<void>();
				const transition = (
					current: typeof scope,
					own: Deferred.Deferred<void>,
					peer: Deferred.Deferred<void>,
				) =>
					storage.transition(current, 1, 0, () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(own, undefined);
							yield* Deferred.await(peer);
							return {
								value: undefined,
								mutation: { _tag: 'Persist' as const, step: 'one', state: 1 },
							};
						}),
					);
				const results = yield* Effect.all(
					[
						transition(scope, firstStarted, secondStarted),
						transition(other, secondStarted, firstStarted),
					],
					{ concurrency: 'unbounded' },
				);
				expect(results.every((result) => result._tag === 'Applied')).toBe(true);
			}),
		);
	});

	it('treats expired rows as inactive on load and create', async () => {
		const program = Effect.gen(function* () {
			const storage = yield* ConversationStorage;
			yield* storage.create(
				{
					scope,
					conversationId: 'old',
					version: 1,
					step: 'one',
					state: 0,
					lastUpdateId: undefined,
					expiresAt: DateTime.makeUnsafe(1000),
				},
				'fail',
			);
			yield* TestClock.adjust('2 seconds');
			expect(yield* storage.load(scope)).toBeUndefined();
			return yield* storage.create(
				{
					scope,
					conversationId: 'new',
					version: 1,
					step: 'one',
					state: 1,
					lastUpdateId: undefined,
					expiresAt: undefined,
				},
				'fail',
			);
		});
		const row = await Effect.runPromise(
			Effect.provide(
				Effect.provide(program, MemoryConversationStorage.layer),
				TestClock.layer(),
			),
		);
		expect(row.conversationId).toBe('new');
	});

	it('expires using TestClock', async () => {
		const program = Effect.gen(function* () {
			const storage = yield* ConversationStorage;
			yield* storage.create(
				{
					scope,
					conversationId: 'flow',
					version: 1,
					step: 'one',
					state: 0,
					lastUpdateId: undefined,
					expiresAt: DateTime.makeUnsafe(1000),
				},
				'fail',
			);
			yield* TestClock.adjust('2 seconds');
			return yield* storage.transition(scope, 1, 0, () =>
				Effect.succeed({
					value: undefined,
					mutation: { _tag: 'Delete' as const },
				}),
			);
		});
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.provide(
					program as Effect.Effect<any, any, ConversationStorage>,
					MemoryConversationStorage.layer,
				),
				TestClock.layer(),
			),
		);
		expect(result._tag).toBe('Expired');
	});
});
