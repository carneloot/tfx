import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Console, Data, Effect, Layer, Redacted, Schedule } from 'effect';
import { BotRuntime } from 'tfx/BotRuntime';
import { Telegram } from 'tfx/Telegram';
import * as TelegramSchemas from 'tfx/TelegramSchemas';
import * as UpdateDelivery from 'tfx/UpdateDelivery';

import type { AppConfigService } from './Config.js';
import * as DemoSummary from './DemoSummary.js';
import * as Layers from './Layers.js';
import * as Program from './Program.js';

class DemoTestError extends Data.TaggedError('DemoTestError')<{
	readonly reason:
		| 'MissingDatabase'
		| 'TranscriptFailure'
		| 'ReminderTimeout'
		| 'MissingSummary'
		| 'SummaryMismatch';
	readonly message: string;
}> {}

if (
	process.env.TEST_DATABASE_URL === undefined &&
	process.env.RUN_TESTCONTAINERS !== 'true'
) {
	throw new DemoTestError({
		reason: 'MissingDatabase',
		message: 'demo:test requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true',
	});
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
const config = {
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
} satisfies AppConfigService;
const update = (id: number, text: string) =>
	TelegramSchemas.Update.make({
		update_id: id,
		message: {
			message_id: id,
			date: Math.floor(Date.now() / 1000),
			chat: { id: 7201, type: 'private' },
			from: { id: 5201, is_bot: false, first_name: 'Demo' },
			text,
			...(text.startsWith('/')
				? {
						entities: [{ type: 'bot_command', offset: 0, length: text.length }],
					}
				: {}),
		},
	});
const telegram = Layer.mock(Telegram, {
	sendMessage: () =>
		Effect.succeed(
			TelegramSchemas.Message.make({
				message_id: 1,
				date: 0,
				chat: { id: 7201, type: 'private' },
			}),
		),
	setMessageReaction: () => Effect.succeed(true),
	answerCallbackQuery: () => Effect.succeed(true),
});
const transcript = Object.freeze([
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
]);
const program = Effect.scoped(
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
		yield* sql.unsafe('DROP SCHEMA IF EXISTS tfx_demo_test CASCADE');
		const suppliedPg = Layer.succeed(PgClient.PgClient, sql);
		const graph = Layers.portable(config, {
			pg: suppliedPg,
			telegram,
			delivery: UpdateDelivery.manual,
			botUsername: config.botUsername,
		});
		const context = yield* Layer.build(graph);
		for (const [index, text] of transcript.entries()) {
			const outcome = yield* Effect.provide(
				Effect.flatMap(BotRuntime, (runtime) =>
					runtime.dispatch(update(index + 1, text)),
				),
				context,
			);
			if (outcome._tag !== 'Handled')
				return yield* Effect.fail(
					new DemoTestError({
						reason: 'TranscriptFailure',
						message: `demo transcript failed at ${text}: ${outcome._tag}`,
					}),
				);
		}
		const db = sql;
		// Parameterize scheduled reminder to due-now only after transcript commits.
		yield* db`UPDATE tfx_demo_test.case_jobs SET run_at=now() WHERE declaration='feeding-reminder' AND status='scheduled'`;
		const awaitReminder = Effect.flatMap(
			db<{
				status: string;
			}>`SELECT status FROM carneloot.notification_events LIMIT 1`,
			(rows) =>
				rows[0]?.status === 'completed'
					? Effect.void
					: Effect.fail(
							new DemoTestError({
								reason: 'ReminderTimeout',
								message: 'demo reminder did not complete',
							}),
						),
		).pipe(
			Effect.retry(Schedule.max([Schedule.spaced(10), Schedule.recurs(200)])),
		);
		yield* awaitReminder;
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
			return yield* Effect.fail(
				new DemoTestError({
					reason: 'MissingSummary',
					message: 'demo persisted summary missing',
				}),
			);
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
				new DemoTestError({
					reason: 'SummaryMismatch',
					message: `demo persisted summary mismatch: ${summary}`,
				}),
			);
		yield* Console.log(summary);
	}),
);
BunRuntime.runMain(Effect.provide(program, postgres));
