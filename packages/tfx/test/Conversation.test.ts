import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as Conversation from '../src/Conversation.js';
import * as ConversationBuilder from '../src/ConversationBuilder.js';
import * as ConversationInput from '../src/ConversationInput.js';
import { Conversations } from '../src/Conversations.js';
import * as ConversationsLive from '../src/Conversations.js';
import { ConversationStorage } from '../src/ConversationStorage.js';
import * as MemoryConversationStorage from '../src/MemoryConversationStorage.js';

const scope = { botId: 'bot', chatId: 1, userId: 2 };
const declaration = Conversation.make('counter', {
	version: 1,
	startup: Schema.Number,
	error: undefined as unknown as string,
	initialStep: 'count',
	initialize: (n) => n,
	steps: {
		count: Conversation.step('count', {
			state: Schema.Number,
			input: ConversationInput.text(Schema.NumberFromString),
		}),
	},
	idleTimeout: 1000,
});

describe('Conversation', () => {
	it('starts, commits before output, and never replays the same update', async () => {
		let handlers = 0;
		let enters = 0;
		const built = ConversationBuilder.done(
			ConversationBuilder.make(declaration).step('count', {
				enter: (state) =>
					Effect.suspend(() => {
						enters++;
						return state > 0 ? Effect.fail('output') : Effect.void;
					}),
				onInput: (state, input) =>
					Effect.sync(() => {
						handlers++;
						return ConversationBuilder.to('count', state + input);
					}),
			}),
		);
		const program = Effect.gen(function* () {
			const conversations = yield* Conversations;
			const storage = yield* ConversationStorage;
			yield* conversations.start(built, 0, { scope });
			const first = yield* Effect.exit(
				conversations.resume(built, 2, { scope, updateId: 10 }),
			);
			expect(first._tag).toBe('Failure');
			expect(yield* storage.load(scope)).toMatchObject({
				state: 2,
				revision: 1,
				lastUpdateId: 10,
			});
			const replay = yield* conversations.resume(built, 2, {
				scope,
				updateId: 10,
			});
			expect(replay._tag).toBe('Duplicate');
			expect(handlers).toBe(1);
			expect(enters).toBe(2);
		});
		await Effect.runPromise(
			Effect.provide(
				Effect.provide(
					program as Effect.Effect<
						void,
						unknown,
						Conversations | ConversationStorage
					>,
					ConversationsLive.layer,
				),
				MemoryConversationStorage.layer,
			),
		);
	});

	it('requires explicit normalized scope', async () => {
		const built = ConversationBuilder.done(
			ConversationBuilder.make(declaration).step('count', {
				enter: () => Effect.void,
				onInput: () => Effect.succeed(ConversationBuilder.complete()),
			}),
		);
		const program = Effect.flatMap(Conversations, (service) =>
			service.start(built, 0, {}),
		);
		await expect(
			Effect.runPromise(
				Effect.provide(
					Effect.provide(
						program as Effect.Effect<void, unknown, Conversations>,
						ConversationsLive.layer,
					),
					MemoryConversationStorage.layer,
				),
			),
		).rejects.toMatchObject({ _tag: 'ConversationScopeUnavailable' });
	});
});
