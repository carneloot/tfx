import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Console, Effect, Layer, Redacted } from 'effect';
import { BotRuntime } from 'tfx/BotRuntime';
import { Telegram } from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';

import type { AppConfigService } from './Config.js';
import * as DemoSummary from './DemoSummary.js';
import * as Layers from './Layers.js';
import * as Program from './Program.js';

if (
	process.env.TEST_DATABASE_URL === undefined &&
	process.env.RUN_TESTCONTAINERS !== 'true'
) {
	throw new Error(
		'demo:test requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true',
	);
}
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
	botToken: Redacted.make('fake-demo-token'),
	databaseUrl: Redacted.make('postgres://redacted'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeoutSeconds: 30,
	pollingRetryDelayMillis: 100,
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdleMillis: 10,
	jobLeaseMillis: 30_000,
	jobHeartbeatMillis: 10_000,
	dedupLeaseMillis: 30_000,
	dedupHeartbeatMillis: 10_000,
	dedupWaitMillis: 1_000,
	dedupRetentionMillis: 86_400_000,
	tfxSchema: 'tfx_demo_test',
	tfxTablePrefix: 'case_',
};
const update = (id: number, text: string) => ({
	update_id: id,
	message: {
		message_id: id,
		date: Math.floor(Date.now() / 1000),
		chat: { id: 7201, type: 'private' },
		from: { id: 5201, is_bot: false, first_name: 'Demo' },
		text,
		...(text.startsWith('/')
			? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] }
			: {}),
	},
});
const telegram = Layer.succeed(Telegram, {
	sendMessage: () => Effect.succeed({ message_id: 1 }),
	setMessageReaction: () => Effect.succeed(true),
	answerCallbackQuery: () => Effect.succeed(true),
} as never);
const graph = Layers.portable(config, {
	pg: postgres,
	telegram,
	delivery: UpdateDelivery.manual,
	botUsername: config.botUsername,
});
const transcript = [
	'/cadastrar',
	'/adicionar_pet',
	'Rex',
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
] as const;
const program = Effect.scoped(
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
		yield* sql.unsafe('DROP SCHEMA IF EXISTS tfx_demo_test CASCADE');
		const context = yield* Layer.build(Layer.merge(graph, postgres));
		for (const [index, text] of transcript.entries()) {
			const outcome = yield* Effect.provide(
				Effect.flatMap(BotRuntime, (runtime) =>
					runtime.dispatch(update(index + 1, text) as never),
				),
				context,
			);
			if (outcome._tag !== 'Handled')
				return yield* Effect.fail(
					new Error(`demo transcript failed at ${text}: ${outcome._tag}`),
				);
		}
		const db = yield* Effect.provide(PgClient.PgClient, context);
		// Parameterize scheduled reminder to due-now only after transcript commits.
		yield* db`UPDATE tfx_demo_test.case_jobs SET run_at=now() WHERE declaration='feeding-reminder' AND status='scheduled'`;
		const awaitReminder = (remaining: number): Effect.Effect<void, Error> =>
			Effect.flatMap(
				db<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events LIMIT 1`,
				(rows) =>
					rows[0]?.status === 'completed'
						? Effect.void
						: remaining === 0
							? Effect.fail(new Error('demo reminder did not complete'))
							: Effect.andThen(Effect.sleep(10), awaitReminder(remaining - 1)),
			);
		yield* awaitReminder(200);
		yield* Effect.provide(Program.releaseSmokeHealth, context);
		const [counts] = yield* db<{
			users: number;
			pets: number;
			food_entries: number;
			reminder_events: number;
		}>`SELECT (SELECT count(*)::int FROM carneloot.users) users,(SELECT count(*)::int FROM carneloot.pets) pets,(SELECT count(*)::int FROM carneloot.pet_food_entries) food_entries,(SELECT count(*)::int FROM carneloot.notification_events) reminder_events`;
		const [event] = yield* db<{
			status: 'scheduled' | 'completed';
		}>`SELECT status FROM carneloot.notification_events LIMIT 1`;
		const [delivery] = yield* db<{
			status: 'sent' | 'unknown' | 'failed';
		}>`SELECT status FROM carneloot.notification_deliveries LIMIT 1`;
		if (!counts || !event || !delivery)
			return yield* Effect.fail(new Error('demo persisted summary missing'));
		const summary = DemoSummary.format({
			users: counts.users,
			pets: counts.pets,
			foodEntries: counts.food_entries,
			reminderEvents: counts.reminder_events,
			reminderStatus: event.status,
			deliveryOutcome: delivery.status,
		});
		const expected =
			'users=1 pets=1 food_entries=1 reminder_events=1 reminder_status=completed delivery_outcome=sent';
		if (summary !== expected)
			return yield* Effect.fail(
				new Error(`demo persisted summary mismatch: ${summary}`),
			);
		yield* Console.log(summary);
	}),
) as Effect.Effect<void, unknown, never>;
BunRuntime.runMain(Effect.provide(program, postgres));
