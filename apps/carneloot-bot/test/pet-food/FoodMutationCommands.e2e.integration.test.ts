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
	tfxSchema: 'tfx_food_mutation_e2e',
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
const update = (id: number, text: string, sender: Sender, date: number) => ({
	update_id: id,
	message: {
		message_id: id,
		date,
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
	describe.skip('food mutation command PostgreSQL E2E', () => {
		it('requires PostgreSQL', () => {});
	});
else
	describe('food mutation command PostgreSQL E2E', () => {
		it('reschedules correction/deletion and rejects duplicate, revoked access, and replay', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_food_mutation_e2e CASCADE',
							);
							const sent: Sent[] = [];
							const context = yield* Layer.build(makeGraph(sql, sent));
							const owner: Sender = {
								id: 6401,
								first_name: 'Owner',
								username: 'mutation_owner',
							};
							const caregiver: Sender = {
								id: 6402,
								first_name: 'Caregiver',
								username: 'mutation_caregiver',
							};
							const today = new Date();
							today.setUTCHours(12, 0, 0, 0);
							const date = Math.floor(today.getTime() / 1_000);
							const day = today.toISOString().slice(0, 10);
							const displayDay = `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
							let id = 1;
							const send = (text: string, who = owner) =>
								dispatchWith(context, update(id++, text, who, date));
							for (const [text, who] of [
								['/cadastrar', owner],
								['/cadastrar', caregiver],
								['/adicionar_pet', owner],
								['Rex', owner],
							] as const)
								yield* send(text, who);
							for (const text of [
								'/configurar_inicio_dia',
								'Rex',
								'Alterar',
								'0h',
								'UTC',
								'/configurar_atraso_notificacao',
								'Rex',
								'Definir',
								'8 horas',
								'/adicionar_cuidador',
								'Rex',
								'@mutation_caregiver',
							])
								yield* send(text);
							for (const text of ['/convites_pet', 'Rex (Owner)', 'Sim'])
								yield* send(text, caregiver);
							for (const input of ['50g 08:00', '60g 10:00', '40g 06:00'])
								for (const text of ['/colocar_racao', 'Rex', input])
									yield* send(text);

							const entries = () => sql<{
								id: string;
								amount_mg: string;
								fed_at: Date;
							}>`
								SELECT id,amount_mg,fed_at FROM carneloot.pet_food_entries ORDER BY fed_at`;
							const active = () => sql<{
								food_entry_id: string;
								scheduled_for: Date;
							}>`
								SELECT food_entry_id,scheduled_for FROM carneloot.notification_events WHERE status='scheduled' AND kind='feeding-reminder'`;
							const jobs = () => sql<{ run_at: Date }>`
								SELECT run_at FROM tfx_food_mutation_e2e.case_jobs WHERE status='scheduled' AND conflict_key LIKE 'feeding-reminder:%'`;
							const assertReminder = (target: string, iso: string) =>
								Effect.gen(function* () {
									expect(yield* active()).toEqual([
										{ food_entry_id: target, scheduled_for: new Date(iso) },
									]);
									expect(yield* jobs()).toEqual([{ run_at: new Date(iso) }]);
								});
							let rows = yield* entries();
							const backdated = rows[0]!;
							const previous = rows[1]!;
							const latest = rows[2]!;
							yield* assertReminder(latest.id, `${day}T18:00:00.000Z`);

							// Correction moves from pet and entry choices to keyboard-free text.
							const correctionStart = sent.length;
							yield* send('/corrigir_racao');
							expect(sent[correctionStart]?.replyMarkup).toEqual({
								keyboard: [[{ text: 'Rex' }], [{ text: 'Cancelar' }]],
								one_time_keyboard: true,
								resize_keyboard: true,
							});
							yield* send('Rex');
							const entryKeyboard = {
								keyboard: [
									[{ text: `60 g — ${displayDay} 10:00 — Owner` }],
									[{ text: `50 g — ${displayDay} 08:00 — Owner` }],
									[{ text: `40 g — ${displayDay} 06:00 — Owner` }],
									[{ text: 'Cancelar' }],
								],
								one_time_keyboard: true,
								resize_keyboard: true,
							};
							expect(sent[correctionStart + 1]?.replyMarkup).toEqual(
								entryKeyboard,
							);
							const beforeForged = yield* entries();
							yield* send('registro forjado');
							expect(yield* entries()).toEqual(beforeForged);
							expect(sent.at(-1)?.replyMarkup).toEqual(entryKeyboard);
							yield* send(`60 g — ${displayDay} 10:00 — Owner`);
							expect(sent.at(-1)?.replyMarkup).toEqual({
								remove_keyboard: true,
							});
							yield* send('08:00');
							expect(sent.at(-1)?.replyMarkup).toEqual({
								remove_keyboard: true,
							});
							expect(
								(yield* entries()).find((row) => row.id === latest.id)?.fed_at,
							).toEqual(new Date(`${day}T10:00:00.000Z`));
							yield* assertReminder(latest.id, `${day}T18:00:00.000Z`);

							// Moving latest behind previous makes previous reminder target.
							for (const text of [
								'/corrigir_racao',
								'Rex',
								`60 g — ${displayDay} 10:00 — Owner`,
								'07:00',
							])
								yield* send(text);
							yield* assertReminder(previous.id, `${day}T16:00:00.000Z`);

							// Delete resulting latest, exposing corrected entry; then backdated and final entries.
							for (const target of [
								[
									`50 g — ${displayDay} 08:00 — Owner`,
									latest.id,
									`${day}T15:00:00.000Z`,
								],
								[
									`60 g — ${displayDay} 07:00 — Owner`,
									backdated.id,
									`${day}T14:00:00.000Z`,
								],
							] as const) {
								for (const text of ['/deletar_racao', 'Rex', target[0]])
									yield* send(text);
								yield* assertReminder(target[1], target[2]);
							}

							// Render caregiver options, revoke access, then submit selected entry.
							for (const text of ['/deletar_racao', 'Rex'])
								yield* send(text, caregiver);
							for (const text of [
								'/remover_cuidador',
								'Rex',
								'Caregiver (aceito)',
							])
								yield* send(text);
							const beforeRevoked = (yield* entries()).length;
							yield* send(`40 g — ${displayDay} 06:00 — Owner`, caregiver);
							expect(yield* entries()).toHaveLength(beforeRevoked);
							expect(sent.at(-1)?.text).toBe(
								'Este pet não está mais disponível para você.',
							);

							const finalUpdate = update(
								id++,
								`40 g — ${displayDay} 06:00 — Owner`,
								owner,
								date,
							);
							yield* dispatchWith(
								context,
								update(id++, '/deletar_racao', owner, date),
							);
							yield* send('Rex');
							yield* dispatchWith(context, finalUpdate);
							yield* dispatchWith(context, finalUpdate);
							expect(yield* entries()).toHaveLength(0);
							expect(yield* active()).toHaveLength(0);
							expect(yield* jobs()).toHaveLength(0);
							expect(sentText(sent)).toContain(
								'Digite a nova quantidade, horário, ou ambos:',
							);
						}),
					),
					postgres,
				),
			);
		});
	});
