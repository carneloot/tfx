import { Effect, Layer } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import { ConversationStorage } from '../../src/ConversationStorage.js';
export const conversationStorageConformance = (
	name: string,
	storageLayer: () => Layer.Layer<ConversationStorage, unknown, never>,
) =>
	describe(`${name} ConversationStorage conformance`, () => {
		const scope = { botId: `bot-${name}`, chatId: 1, userId: 2 };
		const run = <A, E>(effect: Effect.Effect<A, E, ConversationStorage>) =>
			Effect.runPromise(Effect.provide(effect, storageLayer()));
		it('create/load, conflict, CAS, replay, completion, and scope identity', async () =>
			run(
				Effect.gen(function* () {
					const storage = yield* ConversationStorage;
					const created = yield* storage.create(
						{
							scope,
							originTrace: undefined,
							conversationId: 'flow',
							version: 1,
							step: 'one',
							state: 0,
							lastUpdateId: undefined,
							expiresAt: undefined,
						},
						'fail',
					);
					expect(yield* storage.load(scope)).toEqual(created);
					expect(
						(yield* storage.transition(scope, 1, 0, () =>
							Effect.succeed({
								value: 1,
								mutation: { _tag: 'Persist' as const, step: 'two', state: 1 },
							}),
						))._tag,
					).toBe('Applied');
					expect(
						(yield* storage.transition(scope, 1, 1, () =>
							Effect.die('duplicate'),
						))._tag,
					).toBe('Duplicate');
					expect(
						(yield* storage.transition(scope, 2, 0, () => Effect.die('stale')))
							._tag,
					).toBe('Stale');
					expect(
						(yield* storage.transition(scope, 2, 1, () =>
							Effect.succeed({
								value: undefined,
								mutation: { _tag: 'Delete' as const },
							}),
						))._tag,
					).toBe('Applied');
					expect(yield* storage.load(scope)).toBeUndefined();
				}),
			));
		it('treats expired rows as inactive for load and conflict create', async () =>
			run(
				Effect.gen(function* () {
					const storage = yield* ConversationStorage;
					const expiredScope = { ...scope, chatId: 99 };
					yield* storage.create(
						{
							originTrace: undefined,
							scope: expiredScope,
							conversationId: 'expired',
							version: 1,
							step: 'one',
							state: 0,
							lastUpdateId: undefined,
							expiresAt: DateTime.makeUnsafe(0),
						},
						'fail',
					);
					expect(yield* storage.load(expiredScope)).toBeUndefined();
					const replacement = yield* storage.create(
						{
							originTrace: undefined,
							scope: expiredScope,
							conversationId: 'replacement',
							version: 1,
							step: 'one',
							state: 1,
							lastUpdateId: undefined,
							expiresAt: undefined,
						},
						'fail',
					);
					expect(replacement.conversationId).toBe('replacement');
					const createScope = { ...scope, chatId: 100 };
					yield* storage.create(
						{
							originTrace: undefined,
							scope: createScope,
							conversationId: 'expired-create',
							version: 1,
							step: 'one',
							state: 0,
							lastUpdateId: undefined,
							expiresAt: DateTime.makeUnsafe(0),
						},
						'fail',
					);
					expect(
						(yield* storage.create(
							{
								originTrace: undefined,
								scope: createScope,
								conversationId: 'replacement-create',
								version: 1,
								step: 'one',
								state: 1,
								lastUpdateId: undefined,
								expiresAt: undefined,
							},
							'fail',
						)).conversationId,
					).toBe('replacement-create');
				}),
			));
	});
