import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer } from 'effect';
import { BotRuntime } from 'tfx/BotRuntime';
import { Telegram } from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../../src/Config.js';
import * as Layers from '../../src/Layers.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (process.env.CI === 'true' && !enabled)
	throw new Error('CI must provide PostgreSQL for owned-pet E2E');
const config: AppConfigService = {
	botToken: { toString: () => '<redacted>' } as never,
	databaseUrl: { toString: () => '<redacted>' } as never,
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeoutSeconds: 30,
	pollingRetryDelayMillis: 100,
	dispatchCapacity: 16,
	dispatchConcurrency: 4,
	jobIdleMillis: 10_000,
	jobLeaseMillis: 30_000,
	jobHeartbeatMillis: 10_000,
	dedupLeaseMillis: 30_000,
	dedupHeartbeatMillis: 10_000,
	dedupWaitMillis: 1_000,
	dedupRetentionMillis: 86_400_000,
	tfxSchema: 'tfx_owned_pet_e2e',
	tfxTablePrefix: 'case_',
};
type Sender = {
	readonly id: number;
	readonly first_name: string;
	readonly last_name?: string;
	readonly username?: string;
};
const messageUpdate = (
	updateId: number,
	text: string,
	sender: Sender | undefined,
) => ({
	update_id: updateId,
	message: {
		message_id: updateId,
		date: Math.floor(Date.now() / 1_000),
		chat: { id: 7001, type: 'private', first_name: 'Owner' },
		...(sender === undefined ? {} : { from: { ...sender, is_bot: false } }),
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
const fixture = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
	yield* sql.unsafe('DROP SCHEMA IF EXISTS tfx_owned_pet_e2e CASCADE');
	const sent: string[] = [];
	let failNext = false;
	const telegram = Layer.succeed(Telegram, {
		sendMessage: (payload: { readonly text: string }) =>
			Effect.suspend(() => {
				if (failNext) {
					failNext = false;
					return Effect.fail(new Error('configured-output-failure') as never);
				}
				sent.push(payload.text);
				return Effect.succeed({ message_id: sent.length });
			}),
		setMessageReaction: () => Effect.succeed(true),
		answerCallbackQuery: () => Effect.succeed(true),
	} as never);
	const graph = Layers.portable(config, {
		pg: PostgresTestLayer.layer,
		telegram,
		delivery: UpdateDelivery.manual,
		botUsername: config.botUsername,
	});
	const context = yield* Layer.build(
		Layer.merge(graph, PostgresTestLayer.layer),
	);
	const dispatch = (update: unknown) =>
		Effect.provide(
			Effect.flatMap(BotRuntime, (runtime) =>
				runtime.dispatch(update as never),
			),
			context,
		);
	return {
		context,
		dispatch,
		sent,
		failNext: () => {
			failNext = true;
		},
	};
});

if (!enabled)
	describe.skip('owned pet food loop E2E', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe.sequential('owned pet food loop E2E', () => {
		it('drives exact public owned-pet transcript and durable state', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const f = yield* fixture;
							const original: Sender = {
								id: 5001,
								first_name: 'Old',
								username: 'old_owner',
							};
							const refreshed: Sender = {
								id: 5001,
								first_name: 'Nova',
								last_name: 'Pessoa',
								username: 'new_owner',
							};
							const transcript: ReadonlyArray<[string, Sender]> = [
								['/cadastrar', original],
								['/cadastrar', refreshed],
								['/adicionar_pet', refreshed],
								['Rex', refreshed],
								['/listar_pets', refreshed],
								['/configurar_inicio_dia', refreshed],
								['Rex', refreshed],
								['Alterar', refreshed],
								['0h', refreshed],
								['America/Sao_Paulo', refreshed],
								['/configurar_atraso_notificacao', refreshed],
								['Rex', refreshed],
								['Definir', refreshed],
								['8 horas', refreshed],
								['/status_racao', refreshed],
								['/colocar_racao', refreshed],
								['Rex', refreshed],
								['50g', refreshed],
								['/status_racao', refreshed],
							];
							for (const [index, [text, sender]] of transcript.entries())
								expect(
									yield* f.dispatch(messageUpdate(index + 1, text, sender)),
								).toMatchObject({ _tag: 'Handled' });
							expect(f.sent).toEqual([
								'Usuário cadastrado com sucesso!',
								'Usuário cadastrado com sucesso!',
								'Qual o nome do seu pet?',
								'Pet cadastrado com sucesso!',
								'1. Rex',
								'Escolha o pet: Rex',
								'Início do dia não configurado. Envie Alterar.',
								'Escolha a hora de 0h a 23h.',
								'Envie o fuso horário, por exemplo America/Sao_Paulo.',
								'Início do dia configurado com sucesso!',
								'Escolha o pet: Rex',
								'Notificações desativadas. Envie Definir.',
								'Envie a duração, por exemplo 30 minutos ou 2 horas.',
								'Atraso de notificação configurado para 8 horas.',
								'- Rex: 0 g, nenhuma ração hoje',
								'Escolha o pet: Rex',
								'Envie a quantidade e, opcionalmente, o horário.',
								'Foram adicionados 50 g de ração para o pet Rex.',
								'- Rex: 50 g, última vez há menos de 1 minuto',
							]);
							const sql = yield* Effect.provide(PgClient.PgClient, f.context);
							const [profile] = yield* sql<{
								username: string;
								first_name: string;
							}>`SELECT username,first_name FROM carneloot.telegram_identities`;
							expect(profile).toEqual({
								username: 'new_owner',
								first_name: 'Nova',
							});
							expect(
								yield* sql`SELECT id FROM carneloot.pets WHERE name='Rex'`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_settings WHERE day_start='00:00' AND time_zone='America/Sao_Paulo' AND reminder_delay_ms=28800000`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries WHERE amount_mg=50000`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM carneloot.notification_events WHERE status='scheduled'`,
							).toHaveLength(1);
							expect(
								yield* sql`SELECT id FROM tfx_owned_pet_e2e.case_jobs WHERE status='scheduled'`,
							).toHaveLength(1);
						}),
					),
					PostgresTestLayer.layer,
				),
			);
		});

		it('proves public guards, missing sender, no-pet output, and cancelar cleanup', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const f = yield* fixture;
							const sender: Sender = { id: 5002, first_name: 'Guard' };
							yield* f.dispatch(messageUpdate(100, '/listar_pets', sender));
							yield* f.dispatch(messageUpdate(101, '/cadastrar', undefined));
							yield* f.dispatch(messageUpdate(102, '/cadastrar', sender));
							yield* f.dispatch(messageUpdate(103, '/listar_pets', sender));
							yield* f.dispatch(messageUpdate(104, '/adicionar_pet', sender));
							yield* f.dispatch(messageUpdate(105, '/cancelar', sender));
							expect(f.sent).toEqual([
								'Por favor cadastre-se primeiro utilizando /cadastrar',
								'Não foi possível identificar o usuário.',
								'Usuário cadastrado com sucesso!',
								'Você não tem pets',
								'Qual o nome do seu pet?',
								'Conversa cancelada.',
							]);
							const sql = yield* Effect.provide(PgClient.PgClient, f.context);
							expect(
								yield* sql`SELECT id FROM tfx_owned_pet_e2e.case_conversations`,
							).toHaveLength(0);

							// Invalid selections stay active and emit correction prompts.
							for (const [id, text] of [
								[106, '/adicionar_pet'],
								[107, 'Rex'],
								[108, '/configurar_inicio_dia'],
								[109, 'Outro'],
								[110, 'Rex'],
								[111, 'Alterar'],
								[112, '24h'],
								[113, '0h'],
								[114, 'Invalid/Zone'],
								[115, 'America/Sao_Paulo'],
								[116, '/colocar_racao'],
								[117, 'Rex'],
								[118, 'quantidade ruim'],
								[119, '10g'],
							] as const)
								yield* f.dispatch(messageUpdate(id, text, sender));
							expect(
								f.sent.filter(
									(text) => text === 'Por favor, escolha uma opção',
								),
							).toHaveLength(3);
							expect(f.sent).toContain(
								'Formato inválido. Envie a quantidade e, opcionalmente, o horário.',
							);
							// Food before delay persists without a reminder.
							expect(
								yield* sql`SELECT id FROM carneloot.notification_events`,
							).toHaveLength(0);
							for (const [id, text] of [
								[120, '/configurar_atraso_notificacao'],
								[121, 'Rex'],
								[122, 'Definir'],
								[123, 'amanhã'],
								[124, '8 horas'],
								[125, '/colocar_racao'],
								[126, 'Rex'],
								[127, '50g'],
							] as const)
								yield* f.dispatch(messageUpdate(id, text, sender));
							expect(f.sent).toContain(
								'Formato inválido. Envie uma duração positiva de até 30 dias.',
							);
							expect(
								yield* sql`SELECT id FROM carneloot.notification_events WHERE status='scheduled'`,
							).toHaveLength(1);
							// Duplicate update/source is acknowledged from durable dedup state.
							yield* f.dispatch(messageUpdate(127, '50g', sender));
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(2);
							// Conversation state commits before configured Telegram output failure.
							f.failNext();
							expect(
								yield* f.dispatch(messageUpdate(128, '/adicionar_pet', sender)),
							).toMatchObject({ _tag: 'HandledWithOutputFailure' });
							expect(
								yield* sql`SELECT id FROM tfx_owned_pet_e2e.case_conversations`,
							).toHaveLength(1);
							yield* f.dispatch(messageUpdate(129, '/cancelar', sender));
							// Force scheduler persistence failure and prove food transaction rollback.
							yield* sql.unsafe(
								`CREATE FUNCTION carneloot.fail_e2e_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced scheduler rollback'; END $$`,
							);
							yield* sql.unsafe(
								`CREATE TRIGGER fail_e2e_event BEFORE INSERT ON carneloot.notification_events FOR EACH ROW EXECUTE FUNCTION carneloot.fail_e2e_event()`,
							);
							yield* f.dispatch(messageUpdate(130, '/colocar_racao', sender));
							yield* f.dispatch(messageUpdate(131, 'Rex', sender));
							expect(
								yield* f.dispatch(messageUpdate(132, '60g', sender)),
							).toMatchObject({ _tag: 'Handled' });
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(2);
							yield* sql.unsafe(
								'DROP TRIGGER fail_e2e_event ON carneloot.notification_events',
							);
							yield* sql.unsafe('DROP FUNCTION carneloot.fail_e2e_event()');
							// Retry same active step with a backdated entry; current reminder stays on 50g.
							yield* f.dispatch(messageUpdate(133, '5g 00:00', sender));
							expect(
								yield* sql`SELECT id FROM carneloot.pet_food_entries`,
							).toHaveLength(3);
							expect(
								yield* sql`SELECT e.id FROM carneloot.notification_events e JOIN carneloot.pet_food_entries f ON f.id=e.food_entry_id WHERE e.status='scheduled' AND f.amount_mg=50000`,
							).toHaveLength(1);
						}),
					),
					PostgresTestLayer.layer,
				),
			);
		});
	});

/*
Checklist evidence: tests above exercise guards, missing sender, no pets,
invalid pet/timezone/duration/food correction, duplicate update/source, no-delay
food, backdated latest-event preservation, forced scheduler rollback, output failure
after commit, and cancelar through public BotRuntime. Lower-level concurrency/race
matrices remain covered by ConversationDurability.integration.test.ts,
PetFood.integration.test.ts, and FeedingReminderScheduling.integration.test.ts.
*/
