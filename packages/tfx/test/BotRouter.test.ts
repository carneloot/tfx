import { Effect, Layer, Schema, Tracer } from 'effect';
import {
	Bot,
	BotBuilder,
	BotGroup,
	BotRouter,
	Command,
	CommandInput,
	Conversation,
	ConversationBuilder,
	ConversationInput,
	ConversationStorage,
	Conversations,
	MemoryConversationStorage,
	MessageContext,
	MessageHandler,
	MessageHandlerResult,
	MessageInput,
	Middleware,
	UpdateContext,
	VersionedSchema,
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
class TestHandlerError extends Schema.TaggedErrorClass<TestHandlerError>()(
	'TestHandlerError',
	{ message: Schema.String },
) {}

const account = BotGroup.make('account').add(
	Command.make('start', {
		name: 'start',
		error: Schema.Union([
			TestHandlerError,
			Conversations.HandledWithOutputFailure,
		]),
	}),
);
const pets = BotGroup.make('pets').add(
	Command.make('list', {
		name: 'pets',
		aliases: ['animals'],
		input: CommandInput.argument('kind', Schema.String),
		error: Schema.Void,
	}),
);
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
	error: Schema.Void,
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
const build = <
	G extends ReadonlyArray<BotBuilder.BuiltGroup<any>>,
	C extends ReadonlyArray<
		Conversations.BuiltConversation & { readonly _requirements?: unknown }
	> = readonly [],
	BeforeConversation extends BotRouter.BeforeConversationEffect | undefined =
		undefined,
>(
	groups: G,
	options: Partial<
		Omit<
			BotRouter.Options<typeof bot, G, C, BeforeConversation>,
			'beforeConversation'
		>
	> & {
		readonly beforeConversation?: BeforeConversation;
	} = {},
) =>
	Effect.provide(
		BotRouter.make({
			bot,
			groups,
			botUsername: 'MyBot',
			...options,
		}),
		infrastructure,
	) as Effect.Effect<BotRouter.Router, never, never>;

const messageDeclaration = Bot.make('message-declared').add(
	BotGroup.make('messages')
		.addMessage(
			MessageHandler.make('first', {
				input: MessageInput.text(Schema.String),
				error: Schema.Void,
			}),
		)
		.addMessage(
			MessageHandler.make('second', {
				input: MessageInput.text(Schema.String),
				error: Schema.Void,
			}),
		),
);

describe('public BotRouter', () => {
	it('uses declaration order for unmatched message handlers', async () => {
		const calls: Array<string> = [];
		const messages = BotBuilder.buildGroup(
			messageDeclaration,
			'messages',
			(handlers) =>
				handlers
					.handleMessage('first', () =>
						Effect.sync(() => {
							calls.push('first');
							return MessageHandlerResult.unmatched;
						}),
					)
					.handleMessage('second', () =>
						Effect.sync(() => {
							calls.push('second');
							return MessageHandlerResult.handled;
						}),
					),
		);
		const router = await Effect.runPromise(
			Effect.provide(
				BotRouter.make({
					bot: messageDeclaration,
					groups: [messages],
					botUsername: 'MyBot',
				}),
				infrastructure,
			) as Effect.Effect<BotRouter.Router, never, never>,
		);
		await Effect.runPromise(router.route(commandUpdate(1, 'plain') as never));
		expect(calls).toEqual(['first', 'second']);
	});

	it('classifies framework failures with retry opt-in and fatal defaults', () => {
		expect(
			BotRouter.classifyFrameworkError(
				new ConversationStorage.ConversationStorageError(
					'PersistenceFailure',
					'unavailable',
				),
			),
		).toEqual({
			_tag: 'RetryableFailure',
			error: 'conversation-storage-unavailable',
		});
		expect(
			BotRouter.classifyFrameworkError(
				new ConversationStorage.ConversationStorageError('Conflict', 'active'),
			),
		).toEqual({
			_tag: 'PermanentInvalid',
			reason: 'conversation-conflict',
		});
		expect(
			BotRouter.classifyFrameworkError(
				new ConversationStorage.ConversationStorageError(
					'InvariantViolation',
					'corrupt',
				),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'conversation-storage-invariant',
		});
		expect(
			BotRouter.classifyFrameworkError(
				new VersionedSchema.VersionedSchemaError('MissingMigration', 'missing'),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'conversation-version-invariant',
		});
	});

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
			handlers.handle('list', (input) =>
				Effect.sync(() => invoked.push(`pets:${input.kind}`)),
			),
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
				router.route(commandUpdate(2, '/pets dogs') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(3, '/animals@mybot cats') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(invoked).toEqual(['account:10:20', 'pets:dogs', 'pets:cats']);
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

	it('runs beforeConversation with contexts, short-circuits commands, and maps hook errors safely', async () => {
		let commandCalls = 0;
		const seen: Array<{ readonly updateId: number; readonly text: string }> =
			[];
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.sync(() => {
					commandCalls++;
				}),
			),
		);
		const router = await Effect.runPromise(
			build([handlers], {
				beforeConversation: () =>
					Effect.gen(function* () {
						const update = yield* UpdateContext.UpdateContext;
						const message = yield* MessageContext.MessageContext;
						seen.push({
							updateId: update.updateId,
							text: message.message.text!,
						});
						return { _tag: 'Handled' } as const;
					}),
			}),
		);
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(1, '/start') as never),
			),
		).toEqual({ _tag: 'Handled' });
		expect(seen).toEqual([{ updateId: 1, text: '/start' }]);
		expect(commandCalls).toBe(0);
		expect(
			await Effect.runPromise(
				router.route({
					update_id: 2,
					callback_query: {
						id: 'cb',
						from: { id: 1, is_bot: false, first_name: 'A' },
						chat_instance: 'x',
						data: 'x',
					},
				} as never),
			),
		).toMatchObject({ _tag: 'PermanentInvalid' });
		expect(seen).toEqual([{ updateId: 1, text: '/start' }]);

		const fallingThroughRouter = await Effect.runPromise(
			build([handlers], {
				beforeConversation: () => Effect.succeed(undefined),
			}),
		);
		await Effect.runPromise(
			fallingThroughRouter.route(commandUpdate(2, '/start') as never),
		);
		expect(commandCalls).toBe(1);

		const failingRouter = await Effect.runPromise(
			build([handlers], {
				beforeConversation: () =>
					Effect.fail(new TestHandlerError({ message: 'token=secret' })),
				mapError: () => ({
					_tag: 'RetryableFailure',
					error: 'safe-domain-error',
				}),
			}),
		);
		expect(
			await Effect.runPromise(
				failingRouter.route(commandUpdate(3, '/start') as never),
			),
		).toEqual({ _tag: 'RetryableFailure', error: 'safe-domain-error' });
	});

	it('defaults unclassified handler errors to fatal', async () => {
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.fail(new TestHandlerError({ message: 'not retryable' })),
			),
		);
		const router = await Effect.runPromise(build([handlers]));
		expect(
			await Effect.runPromise(
				router.route(commandUpdate(1, '/start') as never),
			),
		).toEqual({
			_tag: 'Fatal',
			cause: 'unclassified-router-error',
		});
	});

	it('rejects unsafe ingress ids and returns safe output-failure markers', async () => {
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.fail(
					new Conversations.HandledWithOutputFailure({
						cause: new TestHandlerError({ message: 'token=secret' }),
					}),
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

	it('short-circuits active conversations only for defined beforeConversation outcomes', async () => {
		resumed = 0;
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.gen(function* () {
					const update = yield* UpdateContext.UpdateContext;
					const conversations = yield* Conversations.Conversations;
					yield* conversations
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
		const groups = [handlers] as const;
		const router = await Effect.runPromise(
			build<
				typeof groups,
				readonly [typeof builtConversation],
				BotRouter.BeforeConversationEffect
			>(groups, {
				conversations: [builtConversation],
				beforeConversation: (update) =>
					Effect.succeed(
						update.update_id === 21 ? { _tag: 'Handled' } : undefined,
					),
			}),
		);
		await Effect.runPromise(router.route(commandUpdate(20, '/start') as never));
		await Effect.runPromise(
			router.route({
				...commandUpdate(21, '4'),
				message: { ...commandUpdate(21, '4').message, entities: [] },
			} as never),
		);
		expect(resumed).toBe(0);
		await Effect.runPromise(
			router.route({
				...commandUpdate(22, '4'),
				message: { ...commandUpdate(22, '4').message, entities: [] },
			} as never),
		);
		expect(resumed).toBe(4);
	});

	it('links persisted conversation resumes without recording raw data', async () => {
		const spans: Array<Tracer.Span> = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		const linkedConversation = ConversationBuilder.done(
			ConversationBuilder.make(conversationDeclaration).step('count', {
				enter: () => Effect.void,
				onInput: (state) =>
					Effect.succeed(
						ConversationBuilder.to('count', state + 1, {
							afterCommit: Effect.void,
						}),
					),
				onInvalid: () => Effect.succeed(ConversationBuilder.stay()),
			}),
		);
		const handlers = BotBuilder.buildGroup(bot, 'account', (value) =>
			value.handle('start', () =>
				Effect.gen(function* () {
					const update = yield* UpdateContext.UpdateContext;
					const conversations = yield* Conversations.Conversations;
					yield* conversations
						.start(linkedConversation, 0, {
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
		const groups = [handlers] as const;
		const router = await Effect.runPromise(
			build<typeof groups, readonly [typeof linkedConversation]>(groups, {
				conversations: [linkedConversation],
			}),
		);
		await Effect.runPromise(
			Effect.provideService(
				router.route(commandUpdate(30, '/start') as never),
				Tracer.Tracer,
				tracer,
			),
		);
		await Effect.runPromise(
			Effect.provideService(
				router.route({
					...commandUpdate(31, '42'),
					message: {
						...commandUpdate(31, '42').message,
						entities: [],
					},
				} as never),
				Tracer.Tracer,
				tracer,
			),
		);
		const command = spans.find((span) => span.name === 'Command.start');
		const start = spans.find((span) => span.name === 'Conversation.start');
		const resume = spans.find(
			(span) => span.name === 'Conversation.counter.count',
		);
		expect(command).toBeDefined();
		expect(start?.parent._tag).toBe('Some');
		expect(start?.parent._tag === 'Some' ? start.parent.value : undefined).toBe(
			command,
		);
		expect(resume?.links).toHaveLength(1);
		expect(resume?.links[0]?.span).toMatchObject({
			traceId: start?.traceId,
			spanId: start?.spanId,
		});
		const lifecycleResume = spans.find(
			(span) => span.name === 'Conversation.resume',
		);
		expect(lifecycleResume?.parent._tag).toBe('Some');
		expect(
			lifecycleResume?.parent._tag === 'Some'
				? lifecycleResume.parent.value
				: undefined,
		).toBe(resume);
		for (const name of [
			'Conversation.transition',
			'Conversation.afterCommit',
			'Conversation.enter',
		]) {
			const lifecycle = spans.find((span) => span.name === name);
			expect(lifecycle?.parent._tag).toBe('Some');
			expect(
				lifecycle?.parent._tag === 'Some' ? lifecycle.parent.value : undefined,
			).toBe(lifecycleResume);
		}
		const attributes = spans.flatMap((span) => [...span.attributes.values()]);
		expect(attributes).not.toContain('42');
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
