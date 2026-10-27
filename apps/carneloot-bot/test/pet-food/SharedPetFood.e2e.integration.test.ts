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
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';

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
	tfxSchema: 'tfx_shared_food_e2e',
	tfxTablePrefix: 'case_',
};
type Sender = {
	readonly id: number;
	readonly first_name: string;
	readonly username?: string;
};
type Sent = { readonly chatId: number; readonly text: string };
type Reaction = { readonly chatId: number; readonly messageId: number };
const messageInstantSeconds = Math.floor(
	new Date('2024-01-02T03:30:00.000Z').getTime() / 1_000,
);
const update = (
	id: number,
	text: string,
	sender: Sender,
	date = messageInstantSeconds,
	repliedMessageId?: number,
) => ({
	update_id: id,
	message: {
		message_id: id,
		date,
		from: { ...sender, is_bot: false },
		chat: { id: sender.id, type: 'private', first_name: sender.first_name },
		text,
		...(repliedMessageId === undefined
			? {}
			: {
					reply_to_message: {
						message_id: repliedMessageId,
						date,
						chat: {
							id: sender.id,
							type: 'private',
							first_name: sender.first_name,
						},
					},
				}),
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
const makeGraph = (
	sql: PgClient.PgClient,
	sent: Sent[],
	reactions: Reaction[],
) => {
	const telegram = Layer.succeed(Telegram, {
		sendMessage: (payload: {
			readonly chat_id: number;
			readonly text: string;
		}) =>
			Effect.sync(() => {
				sent.push({ chatId: payload.chat_id, text: payload.text });
				return { message_id: sent.length };
			}),
		setMessageReaction: (payload: {
			readonly chat_id: number;
			readonly message_id: number;
		}) =>
			Effect.sync(() => {
				reactions.push({
					chatId: payload.chat_id,
					messageId: payload.message_id,
				});
				return true;
			}),
		answerCallbackQuery: () => Effect.succeed(true),
	} as never);
	return Layer.provide(
		Layer.provide(
			AppLive.layer(() => UpdateDelivery.manual),
			Layer.mergeAll(
				Layer.succeed(PgClient.PgClient, sql),
				telegram,
				DeterministicCrypto.layer(),
			),
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
	describe.skip('shared pet food PostgreSQL E2E', () => {
		it('requires PostgreSQL', () => {});
	});
else
	describe('shared pet food PostgreSQL E2E', () => {
		it('records /todos once per accessible pet using each pet timezone', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_shared_food_e2e CASCADE',
							);
							const sent: Sent[] = [];
							const reactions: Reaction[] = [];
							const context = yield* Layer.build(
								makeGraph(sql, sent, reactions),
							);
							const owner: Sender = {
								id: 6201,
								first_name: 'Owner',
								username: 'shared_owner',
							};
							const caregiver: Sender = {
								id: 6202,
								first_name: 'Caregiver',
								username: 'shared_caregiver',
							};
							const rejectedCaregiver: Sender = {
								id: 6203,
								first_name: 'Rejected',
								username: 'rejected_caregiver',
							};
							let id = 1;
							const send = (text: string, who = owner) =>
								dispatchWith(context, update(id++, text, who));
							for (const [text, who] of [
								['/cadastrar', owner],
								['/cadastrar', caregiver],
								['/cadastrar', rejectedCaregiver],
								['/adicionar_pet', owner],
								['Rex', owner],
								['/adicionar_pet', owner],
								['Mimi', owner],
							] as const)
								yield* send(text, who);
							for (const text of [
								'/configurar_inicio_dia',
								'Rex',
								'Alterar',
								'0h',
								'America/Sao_Paulo',
								'/configurar_inicio_dia',
								'Mimi',
								'Alterar',
								'0h',
								'Asia/Tokyo',
							])
								yield* send(text);
							for (const pet of ['Rex', 'Mimi']) {
								for (const text of [
									'/adicionar_cuidador',
									pet,
									'@shared_caregiver',
								])
									yield* send(text);
								for (const text of ['/convites_pet', `${pet} (Owner)`, 'Sim'])
									yield* send(text, caregiver);
							}
							for (const text of [
								'/adicionar_cuidador',
								'Rex',
								'@rejected_caregiver',
							])
								yield* send(text);
							for (const text of ['/convites_pet', 'Rex (Owner)', 'Não'])
								yield* send(text, rejectedCaregiver);
							expect(
								yield* sql`SELECT status FROM carneloot.pet_caregivers WHERE caregiver_user_id=(SELECT user_id FROM carneloot.telegram_identities WHERE telegram_user_id=${rejectedCaregiver.id})`,
							).toEqual([{ status: 'rejected' }]);
							const todosId = id++;
							const todosUpdate = update(
								todosId,
								'/todos 50g 08:30',
								caregiver,
							);
							yield* dispatchWith(context, todosUpdate);
							const rows = yield* sql<{
								pet_name: string;
								timezone: string;
								amount_mg: bigint;
								fed_at: Date;
								source_bot_id: string;
								source_update_id: bigint;
								source_message_chat_id: bigint;
								source_message_id: bigint;
								recorded_by_telegram_id: bigint;
							}>`SELECT p.name AS pet_name,s.timezone,e.amount_mg,e.fed_at,
								e.source_bot_id,e.source_update_id,e.source_message_chat_id,
								e.source_message_id,up.telegram_user_id AS recorded_by_telegram_id
							FROM carneloot.pet_food_entries e
							JOIN carneloot.pets p ON p.id=e.pet_id
							JOIN carneloot.pet_food_settings s ON s.pet_id=p.id
							JOIN carneloot.telegram_identities up ON up.user_id=e.recorded_by
							ORDER BY p.name`;
							expect(rows).toHaveLength(2);
							expect(
								rows.map((row) => ({
									...row,
									fed_at: row.fed_at.toISOString(),
								})),
							).toEqual([
								{
									pet_name: 'Mimi',
									timezone: 'Asia/Tokyo',
									amount_mg: 50000n,
									fed_at: '2024-01-01T23:30:00.000Z',
									source_bot_id: 'carneloot',
									source_update_id: BigInt(todosId),
									source_message_chat_id: BigInt(caregiver.id),
									source_message_id: BigInt(todosId),
									recorded_by_telegram_id: BigInt(caregiver.id),
								},
								{
									pet_name: 'Rex',
									timezone: 'America/Sao_Paulo',
									amount_mg: 50000n,
									fed_at: '2024-01-01T11:30:00.000Z',
									source_bot_id: 'carneloot',
									source_update_id: BigInt(todosId),
									source_message_chat_id: BigInt(caregiver.id),
									source_message_id: BigInt(todosId),
									recorded_by_telegram_id: BigInt(caregiver.id),
								},
							]);
							expect(sent.at(-1)).toEqual({
								chatId: caregiver.id,
								text: 'Ração registrada para 2 pets: Mimi, Rex.',
							});
							expect(reactions).toEqual([
								{ chatId: caregiver.id, messageId: todosId },
							]);
							// Delivery replay is absorbed without duplicate per-pet writes or output.
							const sentBeforeReplay = sent.length;
							yield* dispatchWith(context, todosUpdate);
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(2);
							expect(sent).toHaveLength(sentBeforeReplay);
							expect(reactions).toHaveLength(1);
							const entriesBeforeRejectedMutation = yield* sql`
								SELECT id FROM carneloot.pet_food_entries
							`;
							yield* send('/todos 50g 08:30', rejectedCaregiver);
							expect(sent.at(-1)).toEqual({
								chatId: rejectedCaregiver.id,
								text: 'Você não possui nenhum pet.',
							});
							yield* send('/parar_de_cuidar_pet', rejectedCaregiver);
							expect(sent.at(-1)).toEqual({
								chatId: rejectedCaregiver.id,
								text: 'Você não está cuidando de nenhum pet.',
							});
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toEqual(entriesBeforeRejectedMutation);
							expect(
								yield* sql`SELECT conversation_id FROM tfx_shared_food_e2e.case_conversations WHERE user_id=${rejectedCaregiver.id}`,
							).toHaveLength(0);

							// Relative times share a message anchor even across different pet zones.
							yield* sql`UPDATE carneloot.pet_food_settings SET reminder_delay_ms=3600000`;
							const at = (iso: string) => Date.parse(iso) / 1_000;
							const relativeId = id++;
							const relativeUpdate = update(
								relativeId,
								'/todos 8 -5min',
								caregiver,
								at('2024-01-02T15:00:30Z'),
							);
							const relativeEntries = () => sql<{
								pet_name: string;
								amount_mg: bigint;
								fed_at: Date;
							}>`
								SELECT p.name pet_name,e.amount_mg,e.fed_at FROM carneloot.pet_food_entries e
								JOIN carneloot.pets p ON p.id=e.pet_id WHERE e.source_update_id=${relativeId} ORDER BY p.name`;
							const persistedEntries = () => sql`
								SELECT id,amount_mg,fed_at,updated_at FROM carneloot.pet_food_entries ORDER BY id`;
							yield* dispatchWith(context, relativeUpdate);
							expect(yield* relativeEntries()).toEqual(
								['Mimi', 'Rex'].map((pet_name) => ({
									pet_name,
									amount_mg: 8000n,
									fed_at: new Date('2024-01-02T14:55:30Z'),
								})),
							);
							yield* dispatchWith(context, relativeUpdate);
							// Bypass transport deduplication to exercise per-pet application replay too.
							yield* sql`DELETE FROM tfx_shared_food_e2e.case_update_deduplication WHERE bot_id='carneloot' AND update_id=${relativeId}`;
							yield* dispatchWith(context, relativeUpdate);
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(4);
							for (const text of [
								'/todos 8 -1.5min',
								'/colocar_racao_todos 8 -5min extra',
							])
								yield* dispatchWith(context, update(id++, text, caregiver));
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(4);

							yield* dispatchWith(
								context,
								update(
									id++,
									'/colocar_racao_todos 9 -17min',
									caregiver,
									at('2024-01-02T15:20:30Z'),
								),
							);
							expect(
								yield* sql`SELECT fed_at FROM carneloot.pet_food_entries WHERE amount_mg=9000`,
							).toEqual([
								{ fed_at: new Date('2024-01-02T15:03:30Z') },
								{ fed_at: new Date('2024-01-02T15:03:30Z') },
							]);

							// A reply corrects from its own message date, not the stored feeding.
							const correction = update(
								id++,
								'10 -3min',
								caregiver,
								at('2024-01-02T15:31:30Z'),
								relativeId,
							);
							yield* dispatchWith(context, correction);
							const correctedEntries = yield* persistedEntries();
							yield* dispatchWith(context, correction);
							yield* sql`DELETE FROM tfx_shared_food_e2e.case_update_deduplication WHERE bot_id='carneloot' AND update_id=${correction.update_id}`;
							yield* dispatchWith(context, correction);
							expect(yield* persistedEntries()).toEqual(correctedEntries);
							expect(yield* relativeEntries()).toEqual(
								['Mimi', 'Rex'].map((pet_name) => ({
									pet_name,
									amount_mg: 10000n,
									fed_at: new Date('2024-01-02T15:28:30Z'),
								})),
							);
							const reminders = () => sql<{
								pet_name: string;
								scheduled_for: Date;
								run_at: Date;
							}>`
								SELECT p.name pet_name,n.scheduled_for,j.run_at FROM carneloot.notification_events n
								JOIN carneloot.pets p ON p.id=n.pet_id JOIN tfx_shared_food_e2e.case_jobs j ON j.id=n.job_id
								WHERE n.kind='feeding-reminder' AND n.status='scheduled' ORDER BY p.name`;
							expect(yield* reminders()).toEqual(
								['Mimi', 'Rex'].map((pet_name) => ({
									pet_name,
									scheduled_for: new Date('2024-01-02T16:28:30Z'),
									run_at: new Date('2024-01-02T16:28:30Z'),
								})),
							);
							yield* dispatchWith(
								context,
								update(
									id++,
									'11',
									caregiver,
									at('2024-01-02T15:40:30Z'),
									relativeId,
								),
							);
							expect(
								(yield* relativeEntries()).map((entry) => entry.fed_at),
							).toEqual([
								new Date('2024-01-02T15:28:30Z'),
								new Date('2024-01-02T15:28:30Z'),
							]);

							// Revoke one shared pet before a second correction; only the other can change.
							yield* sql`UPDATE carneloot.pet_caregivers SET status='rejected' WHERE pet_id=(SELECT id FROM carneloot.pets WHERE name='Rex')`;
							yield* dispatchWith(
								context,
								update(
									id++,
									'-1min',
									caregiver,
									at('2024-01-02T15:45:30Z'),
									relativeId,
								),
							);
							expect(yield* relativeEntries()).toEqual([
								{
									pet_name: 'Mimi',
									amount_mg: 11000n,
									fed_at: new Date('2024-01-02T15:44:30Z'),
								},
								{
									pet_name: 'Rex',
									amount_mg: 11000n,
									fed_at: new Date('2024-01-02T15:28:30Z'),
								},
							]);

							// Seed a previously sent reminder's Telegram identity, then reply through the bot.
							yield* sql`INSERT INTO carneloot.notification_deliveries
								(id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_generation,attempt_count,sending_started_at,telegram_bot_id,telegram_message_id,sent_at,created_at,updated_at)
								SELECT gen_random_uuid(),n.id,i.user_id,i.private_chat_id,'caregiver','telegram','sent',1,1,now(),'carneloot',99999,now(),now(),now()
								FROM carneloot.notification_events n JOIN carneloot.pets p ON p.id=n.pet_id
								JOIN carneloot.telegram_identities i ON i.telegram_user_id=${caregiver.id}
								WHERE p.name='Mimi' AND n.kind='feeding-reminder' AND n.status='scheduled'`;
							const reminderReply = update(
								id++,
								'12 g -7min',
								caregiver,
								at('2024-01-02T16:00:30Z'),
								99999,
							);
							yield* dispatchWith(context, reminderReply);
							const afterReminderReply = yield* persistedEntries();
							yield* dispatchWith(context, reminderReply);
							yield* sql`DELETE FROM tfx_shared_food_e2e.case_update_deduplication WHERE bot_id='carneloot' AND update_id=${reminderReply.update_id}`;
							yield* dispatchWith(context, reminderReply);
							yield* dispatchWith(
								context,
								update(
									id++,
									'12 -7min extra',
									caregiver,
									at('2024-01-02T16:10:30Z'),
									99999,
								),
							);
							expect(sent.at(-1)?.text).toBe('Formato de ração inválido.');
							expect(yield* persistedEntries()).toEqual(afterReminderReply);
							expect(
								yield* sql`SELECT amount_mg,fed_at FROM carneloot.pet_food_entries WHERE source_update_id=${reminderReply.update_id}`,
							).toEqual([
								{ amount_mg: 12000n, fed_at: new Date('2024-01-02T15:53:30Z') },
							]);
							expect(yield* reminders()).toEqual([
								{
									pet_name: 'Mimi',
									scheduled_for: new Date('2024-01-02T16:53:30Z'),
									run_at: new Date('2024-01-02T16:53:30Z'),
								},
								{
									pet_name: 'Rex',
									scheduled_for: new Date('2024-01-02T16:28:30Z'),
									run_at: new Date('2024-01-02T16:28:30Z'),
								},
							]);
						}),
					),
					postgres,
				),
			);
		});
	});
