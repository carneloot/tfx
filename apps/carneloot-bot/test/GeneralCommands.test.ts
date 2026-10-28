import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Fiber, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as TestClock from 'effect/testing/TestClock';
import { BotRuntime, Middleware } from 'tfx';
import * as Conversations from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import * as MemoryUpdateDeduplicator from 'tfx/MemoryUpdateDeduplicator';
import { Telegram, type TelegramService } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import { menuCommands } from '../src/bot/Declaration.js';
import * as ForwardToOwner from '../src/bot/ForwardToOwner.js';
import * as RegisteredUser from '../src/bot/RegisteredUser.js';
import { UserNotRegistered } from '../src/domain/DomainError.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { NotificationRepository } from '../src/ports/NotificationRepository.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import * as Router from '../src/Router.js';
import * as DeterministicCrypto from './internal/DeterministicCrypto.js';

const current = {
	user: {
		id: Schema.decodeUnknownSync(UserId)(
			'00000000-0000-4000-8000-000000000001',
		),
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	},
	profile: {
		botId: Schema.decodeUnknownSync(BotId)('carneloot'),
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
		username: 'ana',
		firstName: 'Ana',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
	},
};
type Sent = Parameters<TelegramService['sendMessage']>[0];
type Photo = Parameters<TelegramService['sendPhoto']>[0];

const fixture = (registered = false, storedReply?: unknown) => {
	const sent: Sent[] = [];
	const photos: Photo[] = [];
	const petNames: string[] = [];
	let updateId = 0;
	const dependencies = Layer.mergeAll(
		Layer.mock(Telegram, {
			sendMessage: (payload) =>
				Effect.sync(() => {
					sent.push(payload);
					return { message_id: sent.length } as never;
				}),
			sendPhoto: (payload) =>
				Effect.sync(() => {
					photos.push(payload);
					return {} as never;
				}),
		}),
		Layer.mock(UserRepository, {
			findByTelegram: () =>
				registered
					? Effect.succeed(current)
					: Effect.fail(new UserNotRegistered({ message: 'missing' })),
		}),
		Layer.mock(PetRepository, {
			addOwned: (ownerId, name) =>
				Effect.sync(() => {
					petNames.push(name);
					return {
						id: Schema.decodeUnknownSync(PetId)(
							'00000000-0000-4000-8000-000000000002',
						),
						ownerId,
						name,
						createdAt: DateTime.makeUnsafe(0),
						updatedAt: DateTime.makeUnsafe(0),
					};
				}),
		}),
		Middleware.layer(RegisteredUser.live),
		Layer.succeed(ForwardToOwner.Settings, {
			ownerChatId: undefined,
			usernames: [],
		}),
		Layer.mock(NotificationRepository, {
			findSentByTelegramMessage: () => Effect.succeed(undefined),
		}),
		DeterministicCrypto.layer(),
		MemoryUpdateDeduplicator.layerMemory,
		Layer.provideMerge(Conversations.layer, MemoryConversationStorage.layer),
		TestClock.layer(),
		// A previously committed food reply is a public replay contract. Its
		// output must consume the message before the hello handler sees it.
		Layer.succeed(
			PgClient.PgClient,
			Object.assign(
				() =>
					Effect.succeed(
						storedReply === undefined ? [] : [{ result_json: storedReply }],
					),
				{
					withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
				},
			) as unknown as PgClient.PgClient,
		),
	);
	const program = <A, E, R>(
		use: (
			dispatch: (
				text: string,
				replyTo?: number,
				withSender?: boolean,
			) => ReturnType<typeof BotRuntime.dispatch>,
		) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const router = yield* Router.make('carneloot_bot');
			const dispatch = (text: string, replyTo?: number, withSender = true) => {
				const id = ++updateId;
				return BotRuntime.dispatch(
					{
						update_id: id,
						message: {
							message_id: id,
							date: 1_700_000_000,
							chat: { id: 42, type: 'private', first_name: 'Ana' },
							...(withSender
								? { from: { id: 42, is_bot: false, first_name: 'Ana' } }
								: {}),
							text,
							...(replyTo === undefined
								? {}
								: {
										reply_to_message: {
											message_id: replyTo,
											date: 0,
											chat: { id: 42, type: 'private', first_name: 'Ana' },
										},
									}),
							...(text.startsWith('/')
								? {
										entities: [
											{
												type: 'bot_command',
												offset: 0,
												length: text.split(/\s/u)[0]?.length ?? 0,
											},
										],
									}
								: {}),
						},
					},
					router,
				);
			};
			return yield* use(dispatch);
		}).pipe(Effect.provide(dependencies)) as Effect.Effect<A, E>;
	return { sent, photos, petNames, program };
};

describe('general commands through public dispatch', () => {
	it('publishes only implemented commands in Portuguese, including aliases', () => {
		expect(menuCommands.map(({ command }) => command)).toEqual([
			'cadastrar',
			'gerar_chave',
			'adicionar_pet',
			'listar_pets',
			'deletar_pet',
			'adicionar_cuidador',
			'remover_cuidador',
			'listar_cuidadores',
			'convites_pet',
			'parar_de_cuidar_pet',
			'configurar_inicio_dia',
			'configurar_atraso_notificacao',
			'status_racao',
			'colocar_racao',
			'corrigir_racao',
			'deletar_racao',
			'colocar_racao_todos',
			'todos',
			'start',
			'cancelar',
			'ping',
			'whats',
			'cafe',
			'cafe_inv',
		]);
		expect(
			menuCommands.every(
				({ description }) =>
					description.length > 0 && description.length <= 256,
			),
		).toBe(true);
	});

	it.each(['', '10001', '-1', 'NaN', 'Infinity', 'nope', '1.5', '500 extra'])(
		'falls back to immediate pong for /ping %s',
		async (input) => {
			const f = fixture();
			await Effect.runPromise(
				f.program((dispatch) => dispatch(`/ping ${input}`)),
			);
			expect(f.sent).toMatchObject([
				{ text: 'pong', reply_parameters: { message_id: 1 } },
			]);
		},
	);

	it.each([
		[0, '0'],
		[500, '500ms'],
		[10000, '10s'],
	] as const)(
		'honors the %s ms delay boundary',
		async (milliseconds, label) => {
			const f = fixture();
			await Effect.runPromise(
				f.program((dispatch) =>
					Effect.gen(function* () {
						const fiber = yield* Effect.forkChild(
							dispatch(`/ping ${milliseconds}`).pipe(
								Effect.timeout('20 seconds'),
							),
						);
						if (milliseconds > 0) {
							yield* TestClock.adjust(milliseconds - 1);
							expect(f.sent).toEqual([]);
							yield* TestClock.adjust(1);
						} else yield* TestClock.adjust(0);
						yield* Fiber.join(fiber);
					}),
				),
			);
			expect(f.sent).toMatchObject([
				{ text: `pong ${label}`, reply_parameters: { message_id: 1 } },
			]);
		},
	);

	it.each([
		['(11) 99999-9999', 'https://wa.me/5511999999999'],
		[
			'+55 11 99999-9999 Olá! a&b? 50% #é\nlinha',
			'https://wa.me/5511999999999?text=Ol%C3%A1%21%20a%26b%3F%2050%25%20%23%C3%A9%0Alinha',
		],
		['0055 (21) 2345-6789 oi', 'https://wa.me/552123456789?text=oi'],
		['55 99999-9999', 'https://wa.me/5555999999999'],
		[
			'5511999999999 já%20foi',
			'https://wa.me/5511999999999?text=j%C3%A1%2520foi',
		],
	])(
		'normalizes Brazilian phone and escapes message for %s',
		async (input, expected) => {
			const f = fixture();
			await Effect.runPromise(
				f.program((dispatch) => dispatch(`/whats ${input}`)),
			);
			expect(f.sent.map(({ text }) => text)).toEqual([expected]);
		},
	);

	it.each([
		'',
		'123',
		'(01) 99999-9999',
		'+1 11 99999-9999',
		'(11 99999-9999',
		'11999999999junk',
	])('returns WhatsApp guidance for %s', async (input) => {
		const f = fixture();
		await Effect.runPromise(
			f.program((dispatch) => dispatch(`/whats ${input}`)),
		);
		expect(f.sent.map(({ text }) => text)).toEqual([
			'Envie uma mensagem no formato (00) 0 0000-0000 [mensagem]. A mensagem, os espaços e os algarismos não numéricos são opcionais',
		]);
	});

	it.each([
		[
			'cafe 500',
			'Quantidade de café: 30 g',
			'60 g a 90 g',
			'Até 300 g',
			'Até 500 g',
		],
		[
			'cafe 350ml 65g/L',
			'Quantidade de café: 23 g',
			'46 g a 68 g',
			'Até 210 g',
			'Até 350 g',
		],
		[
			'cafe 0,75L 64',
			'Quantidade de café: 48 g',
			'96 g a 144 g',
			'Até 450 g',
			'Até 750 g',
		],
		[
			'cafe_inv 27g 72',
			'Quantidade de água: 375 ml',
			'54 g a 81 g',
			'Até 225 g',
			'Até 375 g',
		],
		[
			'cafe_inv 75',
			'Quantidade de água: 1.25 l',
			'150 g a 225 g',
			'Até 750 g',
			'Até 1250 g',
		],
		[
			'cafe_inv 0.033kg 65g/L',
			'Quantidade de água: 508 ml',
			'66 g a 99 g',
			'Até 305 g',
			'Até 508 g',
		],
	])(
		'calculates asymmetric V60 recipe /%s',
		async (input, headline, bloom, second, last) => {
			const f = fixture();
			await Effect.runPromise(f.program((dispatch) => dispatch(`/${input}`)));
			expect(f.sent).toHaveLength(2);
			expect(f.sent[0]?.text).toBe(headline);
			expect(f.sent[1]).toMatchObject({ parse_mode: 'HTML' });
			const table = f.sent[1]?.text;
			for (const value of [
				'<pre>',
				'Água',
				'Qtde.',
				'Tempo',
				bloom,
				second,
				last,
				'Esperar 45 s',
				'Durante 30 s',
				'</pre>',
			])
				expect(table).toContain(value);
		},
	);

	it.each([
		['cafe', 'Me envie a quantidade inicial de água em ml. 😄'],
		['cafe 0', 'Me envie a quantidade inicial de água em ml. 😄'],
		['cafe -500', 'Me envie a quantidade inicial de água em ml. 😄'],
		['cafe 30g', 'Me envie a quantidade inicial de água em ml. 😄'],
		['cafe garbage500', 'Me envie a quantidade inicial de água em ml. 😄'],
		['cafe_inv', 'Me envie a quantidade de café em g. 😄'],
		['cafe_inv 500ml', 'Me envie a quantidade de café em g. 😄'],
		...['0', '-1', 'NaN', '60ml', 'abc', '60 extra'].map((ratio) => [
			`cafe 500 ${ratio}`,
			'Proporção de café para quantidade água invalida. Por favor envie um valor na unidade g/L',
		]),
	])('returns guidance for invalid /%s', async (input, expected) => {
		const f = fixture();
		await Effect.runPromise(f.program((dispatch) => dispatch(`/${input}`)));
		expect(f.sent.map(({ text }) => text)).toEqual([expected]);
	});

	it('handles hello case-insensitively, including unregistered unrelated replies', async () => {
		const f = fixture();
		await Effect.runPromise(
			f.program((dispatch) =>
				Effect.gen(function* () {
					yield* dispatch('/start');
					yield* dispatch('not a greeting');
					yield* dispatch('HELLO there');
					yield* dispatch('well hello!', 99);
					yield* dispatch('/whats 11999999999 hello');
				}),
			),
		);
		expect(f.sent.map(({ text }) => text)).toEqual([
			'É nóis',
			'https://wa.me/5511999999999?text=hello',
		]);
		expect(f.photos).toHaveLength(2);
		expect(f.photos[0]).toEqual({
			chat_id: 42,
			photo: 'https://i.kym-cdn.com/photos/images/original/001/475/422/473.jpg',
		});
	});

	it('lets consumed food replies take precedence over hello', async () => {
		const f = fixture(true, {
			_tag: 'InvalidInput',
			message: 'Formato de ração inválido.',
		});
		await Effect.runPromise(f.program((dispatch) => dispatch('hello', 99)));
		expect(f.sent.map(({ text }) => text)).toEqual([
			'Formato de ração inválido.',
		]);
		expect(f.photos).toEqual([]);
	});

	it('acknowledges cancel without registration, conversation, or sender scope', async () => {
		const f = fixture();
		await Effect.runPromise(
			f.program((dispatch) =>
				Effect.gen(function* () {
					yield* dispatch('/cancelar');
					yield* dispatch('/cancelar@other_bot');
					yield* dispatch('/cancelar', undefined, false);
				}),
			),
		);
		expect(f.sent).toEqual([
			{
				chat_id: 42,
				text: 'Operação cancelada',
				reply_markup: { remove_keyboard: true },
			},
			{
				chat_id: 42,
				text: 'Operação cancelada',
				reply_markup: { remove_keyboard: true },
			},
		]);
	});

	it('lets active conversations consume commands and hello, but always intercepts cancel', async () => {
		const f = fixture(true);
		await Effect.runPromise(
			f.program((dispatch) =>
				Effect.gen(function* () {
					yield* dispatch('/adicionar_pet');
					yield* dispatch('/ping');
					yield* dispatch('/adicionar_pet');
					yield* dispatch('hello');
					yield* dispatch('/adicionar_pet');
					yield* dispatch('/cancelar@other_bot');
					yield* dispatch('/adicionar_pet');
					yield* dispatch('/cancelar@CARNELOOT_BOT');
					yield* dispatch('/cancelar');
					const storage = yield* ConversationStorage;
					expect(
						yield* storage.load({ botId: 'carneloot', chatId: 42, userId: 42 }),
					).toBeUndefined();
				}),
			),
		);
		expect(f.sent.filter(({ text }) => text === 'Operação cancelada')).toEqual([
			expect.objectContaining({ reply_markup: { remove_keyboard: true } }),
			expect.objectContaining({ reply_markup: { remove_keyboard: true } }),
		]);
		expect(f.sent.some(({ text }) => text.startsWith('pong'))).toBe(false);
		expect(f.petNames).toEqual(['/ping', 'hello', '/cancelar@other_bot']);
		expect(f.photos).toEqual([]);
	});
});
