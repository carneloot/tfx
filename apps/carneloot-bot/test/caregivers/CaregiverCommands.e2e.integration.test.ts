import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Context, Effect, Layer, Redacted } from 'effect';
import * as Duration from 'effect/Duration';
import { BotRuntime } from 'tfx/BotRuntime';
import { Telegram } from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import * as AppLive from '../../src/AppLive.js';
import { AppConfig, type AppConfigService } from '../../src/Config.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const postgres =
	process.env.TEST_DATABASE_URL === undefined
		? Layer.unwrap(
				Effect.map(
					Effect.acquireRelease(
						Effect.promise(() =>
							new PostgreSqlContainer('postgres:17-alpine').start(),
						),
						(container) =>
							Effect.promise(() => container.stop()).pipe(Effect.asVoid),
					),
					(container) =>
						PgClient.layer({
							url: Redacted.make(container.getConnectionUri()),
						}),
				),
			)
		: PgClient.layer({ url: Redacted.make(process.env.TEST_DATABASE_URL) });
const config: AppConfigService = {
	botToken: { toString: () => '<redacted>' } as never,
	databaseUrl: { toString: () => '<redacted>' } as never,
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeout: Duration.seconds(30),
	pollingRetryDelay: Duration.millis(100),
	dispatchCapacity: 16,
	dispatchConcurrency: 4,
	jobIdle: Duration.seconds(10),
	jobLease: Duration.seconds(30),
	jobHeartbeat: Duration.seconds(10),
	dedupLease: Duration.seconds(30),
	dedupHeartbeat: Duration.seconds(10),
	dedupWait: Duration.seconds(1),
	dedupRetention: Duration.days(1),
	tfxSchema: 'tfx_caregiver_e2e',
	tfxTablePrefix: 'case_',
};
type Sender = {
	readonly id: number;
	readonly first_name: string;
	readonly username?: string;
};
type Sent = {
	readonly chatId: number;
	readonly text: string;
	readonly replyMarkup: unknown;
};
const sentText = (sent: ReadonlyArray<Sent>) =>
	sent.map((message) => message.text);
const update = (id: number, text: string, sender: Sender) => ({
	update_id: id,
	message: {
		message_id: id,
		date: Math.floor(Date.now() / 1000),
		from: { ...sender, is_bot: false },
		chat: { id: sender.id, type: 'private', first_name: sender.first_name },
		text,
		...(text.startsWith('/')
			? {
					entities: [
						{
							type: 'bot_command',
							offset: 0,
							length: text.split(/\s/u)[0]!.length,
						},
					],
				}
			: {}),
	},
});
const makeGraph = (sql: PgClient.PgClient, sent: Sent[]) => {
	const telegram = Layer.succeed(Telegram, {
		sendMessage: (payload: {
			readonly chat_id: number;
			readonly text: string;
			readonly reply_markup?: unknown;
		}) =>
			Effect.sync(() => {
				sent.push({
					chatId: payload.chat_id,
					text: payload.text,
					replyMarkup: payload.reply_markup,
				});
				return { message_id: sent.length };
			}),
		setMessageReaction: () => Effect.succeed(true),
		answerCallbackQuery: () => Effect.succeed(true),
	} as never);
	return Layer.provide(
		Layer.provide(
			AppLive.layer(() => UpdateDelivery.manual),
			Layer.merge(Layer.succeed(PgClient.PgClient, sql), telegram),
		),
		Layer.succeed(AppConfig, config),
	);
};
const dispatchWith = (context: Context.Context<BotRuntime>, value: unknown) =>
	Effect.provide(
		Effect.flatMap(BotRuntime, (runtime) => runtime.dispatch(value as never)),
		context,
	);

if (!enabled)
	describe.skip('caregiver command PostgreSQL E2E', () => {
		it('requires PostgreSQL', () => {});
	});
else
	describe('caregiver command PostgreSQL E2E', () => {
		it('drives complete caregiver lifecycle and deletes reminder-backed pet', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_caregiver_e2e CASCADE',
							);
							const sent: Sent[] = [];
							const context = yield* Layer.build(makeGraph(sql, sent));
							const owner: Sender = {
								id: 6101,
								first_name: 'Owner',
								username: 'owner_e2e',
							};
							const caregiver: Sender = {
								id: 6102,
								first_name: 'Caregiver',
								username: 'care_e2e',
							};
							let id = 1;
							const send = (text: string, who = owner) =>
								dispatchWith(context, update(id++, text, who));
							for (const [text, who] of [
								['/cadastrar', owner],
								['/cadastrar', caregiver],
								['/adicionar_pet', owner],
								['Rex', owner],
							] as const)
								yield* send(text, who);
							const relation = () =>
								sql<{
									status: string;
								}>`SELECT status FROM carneloot.pet_caregivers`;
							yield* send('/adicionar_cuidador');
							expect(sent.at(-1)?.replyMarkup).toEqual({
								keyboard: [[{ text: 'Rex' }], [{ text: 'Cancelar' }]],
								one_time_keyboard: true,
								resize_keyboard: true,
							});
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(1);
							expect(yield* relation()).toHaveLength(0);
							yield* send('/cancelar');
							expect(yield* relation()).toHaveLength(0);
							expect(sent.at(-1)).toMatchObject({
								chatId: owner.id,
								text: 'Conversa cancelada.',
								replyMarkup: { remove_keyboard: true },
							});
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(0);
							// Visible cancellation removes same selection conversation without invite write.
							yield* send('/adicionar_cuidador');
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(1);
							expect(yield* relation()).toHaveLength(0);
							yield* send('Cancelar');
							expect(yield* relation()).toHaveLength(0);
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(0);
							expect(sent.at(-1)?.replyMarkup).toEqual({
								remove_keyboard: true,
							});
							for (const text of ['/adicionar_cuidador', 'Rex', '@care_e2e'])
								yield* send(text);
							expect(sent.at(-2)?.replyMarkup).toEqual({
								remove_keyboard: true,
							});
							expect((yield* relation())[0]?.status).toBe('pending');
							expect(sent).toContainEqual({
								chatId: caregiver.id,
								text: 'Owner convidou você para cuidar do pet Rex.\nUse /convites_pet para responder.',
							});
							for (const text of ['/adicionar_cuidador', 'Rex', 'care_e2e'])
								yield* send(text);
							expect(yield* relation()).toHaveLength(1);
							expect(sent).toContainEqual({
								chatId: owner.id,
								text: 'Esta pessoa já possui um vínculo com este pet.',
							});
							expect(sent.at(-1)?.text).toBe(
								'Envie o @username da pessoa cuidadora.',
							);
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(1);
							expect((yield* relation())[0]?.status).toBe('pending');
							yield* send('/cancelar');
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(0);
							expect((yield* relation())[0]?.status).toBe('pending');
							for (const text of ['/convites_pet', 'Rex (Owner)', 'Sim'])
								yield* send(text, caregiver);
							expect((yield* relation())[0]?.status).toBe('accepted');
							expect(sent.at(-1)).toEqual({
								chatId: owner.id,
								text: 'Caregiver aceitou o convite para cuidar do pet Rex.',
							});
							for (const text of ['/listar_cuidadores', 'Rex'])
								yield* send(text);
							expect(sent.at(-1)?.text).toContain('Caregiver');
							for (const text of [
								'/remover_cuidador',
								'Rex',
								'Caregiver (aceito)',
							])
								yield* send(text);
							expect(yield* relation()).toHaveLength(0);
							for (const text of ['/adicionar_cuidador', 'Rex', 'care_e2e'])
								yield* send(text);
							for (const text of ['/convites_pet', 'Rex (Owner)', 'Não'])
								yield* send(text, caregiver);
							expect((yield* relation())[0]?.status).toBe('rejected');
							for (const text of [
								'/remover_cuidador',
								'Rex',
								'Caregiver (rejeitado)',
							])
								yield* send(text);
							expect(yield* relation()).toHaveLength(0);
							for (const text of ['/adicionar_cuidador', 'Rex', '@care_e2e'])
								yield* send(text);
							for (const text of ['/convites_pet', 'Rex (Owner)', 'Sim'])
								yield* send(text, caregiver);
							for (const text of ['/parar_de_cuidar_pet', 'Rex', 'Sim'])
								yield* send(text, caregiver);
							expect(yield* relation()).toHaveLength(0);
							// Create settings, food, event and tfx job before deletion.
							for (const text of [
								'/configurar_inicio_dia',
								'Rex',
								'Alterar',
								'0h',
								'America/Sao_Paulo',
								'/configurar_atraso_notificacao',
								'Rex',
								'Definir',
								'8 horas',
								'/colocar_racao',
								'Rex',
								'50g',
							])
								yield* send(text);
							expect(
								yield* sql`SELECT id FROM carneloot.notification_events WHERE status='scheduled'`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM tfx_caregiver_e2e.case_jobs WHERE status='scheduled'`,
							).toHaveLength(1);
							yield* sql`INSERT INTO carneloot.notification_deliveries
							(id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,created_at,updated_at)
							SELECT ${crypto.randomUUID()}::uuid,e.id,e.owner_user_id,${owner.id},'owner','telegram','pending',now(),now()
							FROM carneloot.notification_events e`;
							expect(
								yield* sql`SELECT id FROM carneloot.notification_deliveries`,
							).toHaveLength(1);
							// Non-owner cannot enter deletion flow; reminder transaction remains untouched.
							yield* send('/deletar_pet', caregiver);
							expect(sent.at(-1)).toEqual({
								chatId: caregiver.id,
								text: 'Você não tem pets',
							});
							expect(
								yield* sql`SELECT id FROM carneloot.notification_events WHERE status='scheduled'`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM tfx_caregiver_e2e.case_jobs WHERE status='scheduled'`,
							).toHaveLength(1);
							for (const text of ['/deletar_pet', 'Rex', 'Sim'])
								yield* send(text);
							for (const table of [
								'pets',
								'pet_food_settings',
								'pet_food_entries',
								'pet_caregivers',
								'notification_events',
								'notification_deliveries',
							])
								expect(
									yield* sql.unsafe(`SELECT * FROM carneloot.${table}`),
								).toHaveLength(0);
							expect(
								yield* sql`SELECT id FROM tfx_caregiver_e2e.case_jobs WHERE status='scheduled'`,
							).toHaveLength(0);
							const countSent = (chatId: number, text: string) =>
								sent.filter(
									(message) =>
										message.chatId === chatId && message.text === text,
								).length;
							expect(
								countSent(
									caregiver.id,
									'Owner convidou você para cuidar do pet Rex.\nUse /convites_pet para responder.',
								),
							).toBe(3);
							expect(
								countSent(
									owner.id,
									'Caregiver aceitou o convite para cuidar do pet Rex.',
								),
							).toBe(2);
							expect(
								countSent(
									owner.id,
									'Caregiver rejeitou o convite para cuidar do pet Rex.',
								),
							).toBe(1);
							expect(
								countSent(caregiver.id, 'Você não cuida mais do pet Rex.'),
							).toBe(2);
							expect(sentText(sent)).toContain('Conversa cancelada.');
							expect(
								countSent(owner.id, 'Caregiver parou de cuidar do pet Rex.'),
							).toBe(1);
						}),
					),
					postgres,
				),
			);
		});

		it('resumes invitation confirmation after restart and deduplicates a concurrently revoked relation', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_caregiver_e2e CASCADE',
							);
							const sent: Sent[] = [];
							const owner: Sender = {
								id: 6301,
								first_name: 'Owner',
								username: 'relation_owner',
							};
							const caregiver: Sender = {
								id: 6302,
								first_name: 'Caregiver',
								username: 'relation_caregiver',
							};
							const first = yield* Layer.build(makeGraph(sql, sent));
							for (const [id, text, who] of [
								[200, '/cadastrar', owner],
								[201, '/cadastrar', caregiver],
								[202, '/adicionar_pet', owner],
								[203, 'Rex', owner],
								[204, '/adicionar_cuidador', owner],
								[205, 'Rex', owner],
								[206, '@relation_caregiver', owner],
								[207, '/convites_pet', caregiver],
								[208, 'Rex (Owner)', caregiver],
							] as const)
								yield* dispatchWith(first, update(id, text, who));
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(1);
							const second = yield* Layer.build(makeGraph(sql, sent));
							yield* sql`DELETE FROM carneloot.pet_caregivers`;
							const before = sent.length;
							const final = update(209, 'Sim', caregiver);
							yield* dispatchWith(second, final);
							yield* dispatchWith(second, final);
							expect(sent.slice(before)).toMatchObject([
								{
									chatId: caregiver.id,
									text: 'Este convite não está mais disponível.',
									replyMarkup: { remove_keyboard: true },
								},
							]);
							expect(
								yield* sql`SELECT update_id FROM tfx_caregiver_e2e.case_update_deduplication WHERE update_id=209`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT * FROM carneloot.pet_caregivers`,
							).toHaveLength(0);
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(0);
						}),
					),
					postgres,
				),
			);
		});

		it('resumes persisted selection after layer rebuild with valid keyboard label', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_caregiver_e2e CASCADE',
							);
							const sent: Sent[] = [];
							const owner: Sender = {
								id: 6201,
								first_name: 'Owner',
								username: 'restart_owner',
							};
							const first = yield* Layer.build(makeGraph(sql, sent));
							for (const [id, text] of [
								[100, '/cadastrar'],
								[101, '/adicionar_pet'],
								[102, 'Rex'],
								[103, '/deletar_pet'],
								[104, 'Rex'],
							] as const)
								yield* dispatchWith(first, update(id, text, owner));
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(1);
							const second = yield* Layer.build(makeGraph(sql, sent));
							expect(sent.at(-1)?.replyMarkup).toEqual({
								keyboard: [
									[{ text: 'Sim' }, { text: 'Não' }],
								],
								one_time_keyboard: true,
								resize_keyboard: true,
							});
							yield* dispatchWith(second, update(105, 'Sim', owner));
							expect(
								yield* sql`SELECT id FROM carneloot.pets WHERE name='Rex'`,
							).toHaveLength(0);
							expect(sent.at(-1)?.replyMarkup).toEqual({
								remove_keyboard: true,
							});
							expect(
								yield* sql`SELECT conversation_id FROM tfx_caregiver_e2e.case_conversations`,
							).toHaveLength(0);
						}),
					),
					postgres,
				),
			);
		});
	});
