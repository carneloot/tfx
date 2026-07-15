import { Effect, Layer, Schema } from 'effect';
import {
	Bot,
	BotBuilder,
	BotGroup,
	BotRouter,
	Command,
	Conversation,
	ConversationBuilder,
	ConversationInput,
	Conversations,
	MemoryConversationStorage,
	MessageContext,
	Middleware,
	UpdateContext,
} from 'tfx';
import { describe, expect, it } from 'vitest';

const commandUpdate = (id: number, text: string, user = 10, chat = 20) => ({
	update_id: id,
	message: {
		message_id: id,
		date: 0,
		chat: { id: chat, type: 'private' },
		from: { id: user, is_bot: false, first_name: 'A' },
		text,
		entities: [
			{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length },
		],
	},
});
const account = BotGroup.make('account').add(
	Command.make('start', { name: 'start', error: new Error('declared') }),
);
const pets = BotGroup.make('pets').add(Command.make('list', { name: 'pets' }));
const bot = Bot.make('declared').add(account).add(pets);
const conversationDeclaration = Conversation.make('counter', {
	version: 1,
	startup: Schema.Number,
	initialStep: 'count',
	initialize: (value) => value,
	steps: {
		count: Conversation.step('count', {
			state: Schema.Number,
			input: ConversationInput.text(Schema.NumberFromString),
		}),
	},
});
let resumed = 0;
const builtConversation = ConversationBuilder.done(
	ConversationBuilder.make(conversationDeclaration).step('count', {
		enter: () => Effect.void,
		onInput: (_state, input) =>
			Effect.sync(() => {
				resumed = input;
				return ConversationBuilder.complete();
			}),
	}),
);
const infrastructure = Layer.mergeAll(
	Middleware.layer(),
	MemoryConversationStorage.layer,
	Layer.provide(Conversations.layer, MemoryConversationStorage.layer),
);
const build = <G extends ReadonlyArray<BotBuilder.BuiltGroup<any>>>(
	groups: G,
	options: Partial<BotRouter.Options<typeof bot, G>> = {},
) =>
	Effect.provide(
		BotRouter.make({
			bot,
			groups,
			botUsername: 'MyBot',
			...options,
		}),
		infrastructure,
	);

describe('public BotRouter', () => {
	it('aggregates multiple built groups and provides update/message contexts', async () => {
		const invoked: string[] = [];
		const accountHandlers = BotBuilder.buildGroup(bot, 'account', (handlers) =>
			handlers.handle('start', () =>
				Effect.gen(function* () {
					const update = yield* UpdateContext.UpdateContext;
					const message = yield* MessageContext.MessageContext;
					invoked.push(`account:${update.userId}:${message.chatId}`);
				}),
			),
		);
		const petHandlers = BotBuilder.buildGroup(bot, 'pets', (handlers) =>
			handlers.handle('list', () => Effect.sync(() => invoked.push('pets'))),
		);
		const router = await Effect.runPromise(
			build([accountHandlers, petHandlers]),
		);
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(1, '/start') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(2, '/pets@mybot') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(invoked).toEqual(['account:10:20', 'pets']);
	});

	it('falls through wrong mentions and rejects registered commands lacking handlers', async () => {
		const onlyAccount = BotBuilder.buildGroup(bot, 'account', (handlers) =>
			handlers.handle('start', () => Effect.void),
		);
		const router = await Effect.runPromise(build([onlyAccount]));
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(1, '/start@other') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(
			await Effect.runPromise(router.route(commandUpdate(2, '/pets') as never)),
		).toMatchObject({ _tag: 'PermanentInvalid' });
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(3, '/start unexpected') as never),
			),
		).toEqual({ _tag: 'PermanentInvalid', reason: 'Invalid command input' });
	});

	it('routes cancelar before commands and maps handler errors safely', async () => {
		let cancelled = 0;
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () => Effect.fail(new Error('token=secret'))),
		);
		const router = await Effect.runPromise(
			build([handlers], {
				cancel: () => Effect.sync(() => cancelled++),
				mapError: () => ({
					_tag: 'RetryableFailure',
					error: 'safe-domain-error',
				}),
			}),
		);
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(1, '/cancelar') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(cancelled).toBe(1);
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(2, '/start') as never),
			),
		).toEqual({ _tag: 'RetryableFailure', error: 'safe-domain-error' });
	});

	it('rejects unsafe ingress ids and returns safe output-failure markers', async () => {
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.fail(
					new Conversations.HandledWithOutputFailure(new Error('token=secret')),
				),
			),
		);
		const router = await Effect.runPromise(build([handlers]));
		expect(
			await Effect.runPromise(
				router.route(
					commandUpdate(Number.MAX_SAFE_INTEGER + 1, '/start') as never,
				),
			),
		).toMatchObject({ _tag: 'PermanentInvalid' });
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(2, '/start') as never),
			),
		).toEqual({
			_tag: 'HandledWithOutputFailure',
			error: 'conversation-output-failed',
		});
	});

	it('starts, resumes, and cancels conversations through public services', async () => {
		resumed = 0;
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.gen(function* () {
					const update = yield* UpdateContext.UpdateContext;
					yield* (yield* Conversations.Conversations)
						.start(builtConversation, 0, {
							scope: {
								botId: 'declared',
								chatId: update.chatId!,
								userId: update.userId!,
							},
						})
						.pipe(Effect.orDie);
				}),
			),
		);
		const router = await Effect.runPromise(
			build([handlers], {
				conversations: [builtConversation],
				cancel: () =>
					Effect.gen(function* () {
						const update = yield* UpdateContext.UpdateContext;
						yield* (yield* Conversations.Conversations).cancelCurrent({
							botId: 'declared',
							chatId: update.chatId!,
							userId: update.userId!,
						});
					}),
			}) as Effect.Effect<BotRouter.Router, never, never>,
		);
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(20, '/start') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(
			await Effect.runPromise(
				router.route({
					...commandUpdate(21, '4'),
					message: { ...commandUpdate(21, '4').message, entities: [] },
				} as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(resumed).toBe(4);
		await Effect.runPromise(router.route(commandUpdate(22, '/start') as never));
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(23, '/cancelar') as never),
			),
		).toEqual({ _tag: 'Handled' });
	});

	it('permanently rejects unhandled callbacks', async () => {
		const router = await Effect.runPromise(
			build([] as ReadonlyArray<BotBuilder.BuiltGroup<never>>),
		);
		const outcome = await Effect.runPromise(
			router.route({
				update_id: 1,
				callback_query: {
					id: 'cb',
					from: { id: 1, is_bot: false, first_name: 'A' },
					chat_instance: 'x',
					data: 'x',
				},
			} as never),
		);
		expect(outcome).toMatchObject({ _tag: 'PermanentInvalid' });
	});
});
