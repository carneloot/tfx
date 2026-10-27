import { Effect, Layer, Schema } from 'effect';
import {
	Bot,
	BotBuilder,
	BotGroup,
	BotRouter,
	Conversation,
	ConversationBuilder,
	ConversationInput,
	Conversations,
	MemoryConversationStorage,
	MemoryUpdateDeduplicator,
	MessageContext,
	MessageHandler,
	MessageHandlerResult,
	MessageInput,
	Middleware,
	Telegram,
	TelegramSchemas,
} from 'tfx';
import * as BotRuntime from 'tfx/BotRuntime';
import { NetworkError, TelegramError } from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import * as ForwardToOwner from '../src/bot/ForwardToOwner.js';
import { classifyError } from '../src/Router.js';
import * as DeterministicCrypto from './internal/DeterministicCrypto.js';

type Message = typeof TelegramSchemas.Message.Type;
type MessageExtra = Omit<Partial<Message>, 'text'> & {
	readonly text?: string | undefined;
};
const message = (extra: MessageExtra = {}) =>
	Schema.decodeUnknownSync(TelegramSchemas.Message)(
		Object.fromEntries(
			Object.entries({
				message_id: 37,
				date: 1_700_000_000,
				chat: { id: 72, type: 'private' },
				from: { id: 28, is_bot: false, first_name: 'A', username: 'ALIce' },
				text: 'hello',
				...extra,
			}).filter(([, value]) => value !== undefined),
		),
	);
const update = (value: Message) =>
	TelegramSchemas.Update.make({ update_id: 91, message: value });
const failure = (method: string) =>
	new TelegramError({
		module: 'Telegram',
		method,
		reason: new NetworkError({ message: 'connection lost' }),
	});

const infrastructure = Layer.mergeAll(
	Middleware.layer(),
	MemoryConversationStorage.layer,
	Layer.provide(Conversations.layer, MemoryConversationStorage.layer),
	DeterministicCrypto.layer(),
);

const declaration = Bot.make('forwarding-test')
	.add(
		BotGroup.make('replies').addMessage(
			MessageHandler.make('reply', {
				input: MessageInput.replyText(Schema.String),
				error: Schema.Void,
			}),
		),
	)
	.add(ForwardToOwner.group)
	.add(
		BotGroup.make('general').addMessage(
			MessageHandler.make('hello', {
				input: MessageInput.text(Schema.String),
				error: TelegramError,
			}),
		),
	);
const conversationDeclaration = Conversation.make('private-input', {
	version: 1,
	startup: Schema.Void,
	initialStep: 'input',
	initialize: () => undefined,
	steps: {
		input: Conversation.step('input', {
			state: Schema.Void,
			input: ConversationInput.text(Schema.String),
		}),
	},
	error: Schema.Void,
});
const conversation = ConversationBuilder.done(
	ConversationBuilder.make(conversationDeclaration).step('input', {
		enter: () => Effect.void,
		onInput: () => Effect.succeed(ConversationBuilder.complete()),
	}),
);

const run = async (
	value = message(),
	options: {
		readonly settings?: ForwardToOwner.Options;
		readonly failMethod?: 'forwardMessage' | 'setMessageReaction';
		readonly conversation?: boolean;
		readonly repeat?: boolean;
	} = {},
) => {
	const outputs: Array<{ readonly method: string; readonly payload: unknown }> =
		[];
	const record = (method: string, payload: unknown) =>
		Effect.sync(() => {
			outputs.push({ method, payload });
		});
	const telegram = Layer.mock(Telegram.Telegram, {
		forwardMessage: (payload) =>
			record('forwardMessage', payload).pipe(
				Effect.andThen(
					options.failMethod === 'forwardMessage'
						? Effect.fail(failure('forwardMessage'))
						: Effect.succeed(message()),
				),
			),
		setMessageReaction: (payload) =>
			record('setMessageReaction', payload).pipe(
				Effect.andThen(
					options.failMethod === 'setMessageReaction'
						? Effect.fail(failure('setMessageReaction'))
						: Effect.succeed(true as const),
				),
			),
		sendMessage: (payload) =>
			record('sendMessage', payload).pipe(Effect.as(message())),
	});
	const replies = BotBuilder.buildGroup(declaration, 'replies', (handlers) =>
		handlers.handleMessage('reply', ({ repliedMessageId }) =>
			Effect.succeed(
				repliedMessageId === 15
					? MessageHandlerResult.handled
					: MessageHandlerResult.unmatched,
			),
		),
	);
	const forwarding = BotBuilder.buildGroup(
		declaration,
		'forwarding',
		(handlers) =>
			handlers.handleMessage('forwardToOwner', ForwardToOwner.handle),
	);
	const general = BotBuilder.buildGroup(declaration, 'general', (handlers) =>
		handlers.handleMessage('hello', (text) =>
			Effect.gen(function* () {
				if (/hello/iu.test(text)) {
					const context = yield* MessageContext.MessageContext;
					yield* context.reply('hello response');
				}
				return MessageHandlerResult.handled;
			}),
		),
	);
	const outcomes = await Effect.runPromise(
		Effect.gen(function* () {
			if (options.conversation) {
				const conversations = yield* Conversations.Conversations;
				yield* conversations.start(conversation, undefined, {
					scope: { botId: declaration.name, chatId: 72, userId: 28 },
				});
			}
			const router = yield* BotRouter.make({
				bot: declaration,
				groups: [general, forwarding, replies],
				conversations: [conversation],
				botUsername: 'test_bot',
				mapError: classifyError,
			});
			const first = yield* BotRuntime.dispatch(update(value), router);
			const second = options.repeat
				? yield* BotRuntime.dispatch(update(value), router)
				: undefined;
			return [first, second];
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					infrastructure,
					telegram,
					MemoryUpdateDeduplicator.layerMemory,
					Layer.succeed(
						ForwardToOwner.Settings,
						options.settings ?? {
							ownerChatId: 918273,
							usernames: ['alice'],
						},
					),
				),
			),
		),
	);
	return { outputs, outcomes };
};

describe('configured owner forwarding', () => {
	it('forwards to the owner before reacting, then permits hello, without registration', async () => {
		const { outputs, outcomes } = await run(message(), { repeat: true });
		expect(outcomes).toEqual([{ _tag: 'Handled' }, { _tag: 'Handled' }]);
		expect(outputs).toEqual([
			{
				method: 'forwardMessage',
				payload: { chat_id: 918273, from_chat_id: 72, message_id: 37 },
			},
			{
				method: 'setMessageReaction',
				payload: {
					chat_id: 72,
					message_id: 37,
					reaction: [{ type: 'emoji', emoji: '🕊' }],
				},
			},
			{
				method: 'sendMessage',
				payload: { chat_id: 72, text: 'hello response' },
			},
		]);
	});
	it.each(['bob', undefined])(
		'does not forward username %s',
		async (username) => {
			const { outputs } = await run(
				message({
					text: 'ordinary',
					from: {
						id: 28,
						is_bot: false,
						first_name: 'A',
						...(username === undefined ? {} : { username }),
					},
				}),
			);
			expect(outputs).toEqual([]);
		},
	);
	it('does not forward with disabled settings', async () => {
		const { outputs } = await run(message({ text: 'ordinary' }), {
			settings: { ownerChatId: undefined, usernames: [] },
		});
		expect(outputs).toEqual([]);
	});
	it.each([
		{ text: '/unknown' },
		{ text: '/unknown@test_bot' },
		{
			text: '/unknown@other_bot',
			entities: [{ type: 'bot_command', offset: 0, length: 18 }],
		},
		{
			text: 'see /unknown',
			entities: [{ type: 'bot_command', offset: 4, length: 8 }],
		},
		{
			text: undefined,
			caption: '/unknown',
			caption_entities: [{ type: 'bot_command', offset: 0, length: 8 }],
		},
	] satisfies Array<MessageExtra>)(
		'never forwards commands %j',
		async (extra) => {
			expect((await run(message(extra))).outputs).toEqual([]);
		},
	);
	it('forwards media without requiring text', async () => {
		const { outputs } = await run(
			message({
				text: undefined,
				photo: [
					{
						file_id: 'photo',
						file_unique_id: 'unique',
						width: 10,
						height: 20,
					},
				],
			}),
		);
		expect(outputs.map((output) => output.method)).toEqual([
			'forwardMessage',
			'setMessageReaction',
		]);
	});
	it('does not leak consumed replies or conversation inputs, but forwards unrelated replies', async () => {
		const replied = message({ reply_to_message: message({ message_id: 15 }) });
		expect((await run(replied)).outputs).toEqual([]);
		expect((await run(message(), { conversation: true })).outputs).toEqual([]);
		expect(
			(
				await run(
					message({
						text: undefined,
						photo: [
							{
								file_id: 'photo',
								file_unique_id: 'unique',
								width: 10,
								height: 20,
							},
						],
					}),
					{ conversation: true },
				)
			).outputs,
		).toEqual([]);
		const unrelated = message({
			text: 'ordinary',
			reply_to_message: message({ message_id: 16 }),
		});
		expect(
			(await run(unrelated)).outputs.map((output) => output.method),
		).toEqual(['forwardMessage', 'setMessageReaction']);
	});
	it.each(['forwardMessage', 'setMessageReaction'] as const)(
		'acknowledges %s failure and never resends on duplicate update',
		async (failMethod) => {
			const { outputs, outcomes } = await run(message(), {
				failMethod,
				repeat: true,
			});
			expect(outcomes[0]).toEqual({
				_tag: 'HandledWithOutputFailure',
				error: 'telegram-output-failed',
			});
			expect(outcomes[1]).toEqual(outcomes[0]);
			expect(outputs.map((output) => output.method)).toEqual(
				failMethod === 'forwardMessage'
					? ['forwardMessage']
					: ['forwardMessage', 'setMessageReaction'],
			);
		},
	);
});
