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
const update = (id: number, text: string, sender: Sender) => ({
	update_id: id,
	message: {
		message_id: id,
		date: messageInstantSeconds,
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
							let id = 1;
							const send = (text: string, who = owner) =>
								dispatchWith(context, update(id++, text, who));
							for (const [text, who] of [
								['/cadastrar', owner],
								['/cadastrar', caregiver],
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
								amount_mg: string;
								fed_at: Date;
								source_bot_id: string;
								source_update_id: string;
								source_message_chat_id: string;
								source_message_id: string;
								recorded_by_telegram_id: string;
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
									amount_mg: '50000',
									fed_at: '2024-01-01T23:30:00.000Z',
									source_bot_id: 'carneloot',
									source_update_id: String(todosId),
									source_message_chat_id: String(caregiver.id),
									source_message_id: String(todosId),
									recorded_by_telegram_id: String(caregiver.id),
								},
								{
									pet_name: 'Rex',
									timezone: 'America/Sao_Paulo',
									amount_mg: '50000',
									fed_at: '2024-01-01T11:30:00.000Z',
									source_bot_id: 'carneloot',
									source_update_id: String(todosId),
									source_message_chat_id: String(caregiver.id),
									source_message_id: String(todosId),
									recorded_by_telegram_id: String(caregiver.id),
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
						}),
					),
					postgres,
				),
			);
		});
	});
