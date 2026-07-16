import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { Data, Deferred, Effect, Layer, Redacted } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import { BotRuntime } from 'tfx/BotRuntime';
import { JobStore } from 'tfx/JobStore';
import { Telegram } from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../../src/Config.js';
import * as Layers from '../../src/Layers.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (process.env.CI === 'true' && !enabled)
	throw new Error('CI must run restart E2E with PostgreSQL');
const postgres: Layer.Layer<PgClient.PgClient, unknown, never> =
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
	botToken: Redacted.make('test'),
	databaseUrl: Redacted.make('postgres://test'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeout: Duration.seconds(30),
	pollingRetryDelay: Duration.millis(100),
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdle: Duration.seconds(10),
	jobLease: Duration.millis(300),
	jobHeartbeat: Duration.millis(100),
	dedupLease: Duration.millis(300),
	dedupHeartbeat: Duration.millis(100),
	dedupWait: Duration.millis(100),
	dedupRetention: Duration.days(1),
	tfxSchema: 'tfx_restart_e2e',
	tfxTablePrefix: 'case_',
};
class RestartRecoveryTimeoutError extends Data.TaggedError(
	'RestartRecoveryTimeoutError',
)<{ readonly message: string }> {}

const update = (id: number, text: string) => ({
	update_id: id,
	message: {
		message_id: id,
		date: Math.floor(Date.now() / 1000),
		chat: { id: 7101, type: 'private' },
		from: { id: 5101, is_bot: false, first_name: 'Restart' },
		text,
		...(text.startsWith('/')
			? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] }
			: {}),
	},
});
const build = (sent: string[], reminder?: Deferred.Deferred<void>) => {
	const telegram = Layer.succeed(Telegram, {
		sendMessage: (payload: { readonly text: string }) =>
			Effect.gen(function* () {
				sent.push(payload.text);
				if (payload.text.startsWith('🚨'))
					yield* Deferred.succeed(reminder!, undefined);
				return { message_id: sent.length };
			}),
		setMessageReaction: () => Effect.succeed(true),
		answerCallbackQuery: () => Effect.succeed(true),
	} as never);
	return Layers.portable(config, {
		pg: postgres,
		telegram,
		delivery: UpdateDelivery.manual,
		botUsername: config.botUsername,
	});
};
const dispatch = (context: any, value: unknown) =>
	Effect.provide(
		Effect.flatMap(BotRuntime, (runtime) => runtime.dispatch(value as never)),
		context,
	) as Effect.Effect<
		import('tfx/DispatchOutcome').DispatchOutcome,
		never,
		never
	>;

if (!enabled)
	describe.skip('restart recovery E2E', () => {
		it('requires PostgreSQL', () => {});
	});
else
	describe.sequential('restart recovery E2E', () => {
		it('resumes across real scopes, delivers once after restart, and recovers ambiguous fences', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.scoped(
						Effect.gen(function* () {
							const sql = yield* PgClient.PgClient;
							yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
							yield* sql.unsafe(
								'DROP SCHEMA IF EXISTS tfx_restart_e2e CASCADE',
							);
						}),
					),
					postgres,
				),
			);
			const sentA: string[] = [];
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(build(sentA));
						yield* dispatch(context, update(1, '/cadastrar'));
						yield* dispatch(context, update(2, '/adicionar_pet'));
					}),
				),
			);
			const sentB: string[] = [];
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							Layer.merge(build(sentB), postgres),
						);
						yield* dispatch(context, update(3, 'Rex'));
						const sql = yield* Effect.provide(PgClient.PgClient, context);
						expect(
							yield* sql`SELECT id FROM tfx_restart_e2e.case_conversations`,
						).toHaveLength(0);
						expect(
							yield* sql`SELECT id FROM carneloot.pets WHERE name='Rex'`,
						).toHaveLength(1);
					}),
				),
			);
			expect(sentA).toEqual([
				'Usuário cadastrado com sucesso!',
				'Qual o nome do seu pet?',
			]);
			expect(sentB).toEqual(['Pet cadastrado com sucesso!']);

			const ids = {
				food: crypto.randomUUID(),
				event: crypto.randomUUID(),
				job: crypto.randomUUID(),
			};
			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient;
						const [row] = yield* sql<{
							user_id: string;
							pet_id: string;
						}>`SELECT i.user_id,p.id pet_id FROM carneloot.telegram_identities i JOIN carneloot.pets p ON p.owner_id=i.user_id LIMIT 1`;
						yield* sql`INSERT INTO carneloot.pet_food_settings(pet_id,day_start,timezone,reminder_delay_ms,created_at,updated_at) VALUES (${row!.pet_id}::uuid,'00:00','UTC',1000,now(),now())`;
						yield* sql`INSERT INTO carneloot.pet_food_entries(id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${ids.food}::uuid,${row!.pet_id}::uuid,${row!.user_id}::uuid,50000,now(),'carneloot',9001,now(),now())`;
						yield* sql`INSERT INTO tfx_restart_e2e.case_jobs(id,declaration,payload_version,payload_json,status,attempts,max_attempts,run_at,lease_generation,cancellation_requested,created_at,updated_at) VALUES (${ids.job}::uuid,'feeding-reminder',1,${sql.json({ eventId: ids.event, botId: 'carneloot', petId: row!.pet_id, foodEntryId: ids.food })},'scheduled',0,8,now()+interval '1 hour',0,false,now(),now())`;
						yield* sql`INSERT INTO carneloot.notification_events(id,bot_id,kind,owner_user_id,pet_id,food_entry_id,scheduled_for,status,dedupe_key,job_id,created_at,updated_at) VALUES (${ids.event}::uuid,'carneloot','feeding-reminder',${row!.user_id}::uuid,${row!.pet_id}::uuid,${ids.food}::uuid,now(),'scheduled',${`restart:${ids.event}`},${ids.job}::uuid,now(),now())`;
					}),
					postgres,
				),
			);
			// Close future-due persistence scope, then advance due boundary before
			// constructing fresh application runtime scope.
			await Effect.runPromise(
				Effect.provide(
					Effect.flatMap(
						PgClient.PgClient,
						(sql) =>
							sql`UPDATE tfx_restart_e2e.case_jobs SET run_at=now() WHERE id=${ids.job}::uuid`,
					),
					postgres,
				),
			);
			const reminder = Deferred.makeUnsafe<void>();
			const sentC: string[] = [];
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							Layer.merge(build(sentC, reminder), postgres),
						);
						yield* Deferred.await(reminder);
						const sql = yield* Effect.provide(PgClient.PgClient, context);
						expect(
							yield* sql`SELECT id FROM carneloot.notification_events WHERE id=${ids.event}::uuid AND status='completed'`,
						).toHaveLength(1);
						expect(
							yield* sql`SELECT id FROM carneloot.notification_deliveries WHERE event_id=${ids.event}::uuid AND status='sent'`,
						).toHaveLength(1);
					}),
				),
			);
			expect(sentC.filter((text) => text.startsWith('🚨'))).toHaveLength(1);

			const ambiguous = {
				event: crypto.randomUUID(),
				job: crypto.randomUUID(),
			};
			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient;
						const [base] = yield* sql<{
							user_id: string;
							pet_id: string;
						}>`SELECT owner_id user_id,id pet_id FROM carneloot.pets LIMIT 1`;
						yield* sql`INSERT INTO tfx_restart_e2e.case_jobs(id,declaration,payload_version,payload_json,status,attempts,max_attempts,run_at,lease_generation,cancellation_requested,created_at,updated_at) VALUES (${ambiguous.job}::uuid,'feeding-reminder',1,${sql.json({ eventId: ambiguous.event, botId: 'carneloot', petId: base!.pet_id, foodEntryId: ids.food })},'scheduled',0,8,now(),0,false,now(),now())`;
						yield* sql`INSERT INTO carneloot.notification_events(id,bot_id,kind,owner_user_id,pet_id,food_entry_id,scheduled_for,status,dedupe_key,job_id,created_at,updated_at) VALUES (${ambiguous.event}::uuid,'carneloot','feeding-reminder',${base!.user_id}::uuid,${base!.pet_id}::uuid,${ids.food}::uuid,now(),'dispatching',${`ambiguous:${ambiguous.event}`},${ambiguous.job}::uuid,now(),now())`;
						yield* sql`INSERT INTO carneloot.notification_deliveries(id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_generation,attempt_count,sending_started_at,sending_lease_expires_at,retryable,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${ambiguous.event}::uuid,${base!.user_id}::uuid,5101,'owner','telegram','sending',1,1,now()-interval '2 seconds',now()-interval '1 second',false,now(),now())`;
					}),
					postgres,
				),
			);
			const before = sentC.length;
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							Layer.merge(build(sentC), postgres),
						);
						const sql = yield* Effect.provide(PgClient.PgClient, context);
						const awaitTerminal = (
							remaining: number,
						): Effect.Effect<void, Error> =>
							Effect.flatMap(
								sql<{
									status: string;
								}>`SELECT status FROM tfx_restart_e2e.case_jobs WHERE id=${ambiguous.job}::uuid`,
								(rows) =>
									rows[0]?.status === 'completed'
										? Effect.void
										: remaining === 0
											? Effect.fail(
													new RestartRecoveryTimeoutError({
														message: 'Timed out awaiting ambiguous job',
													}),
												)
											: Effect.andThen(
													Effect.sleep(10),
													awaitTerminal(remaining - 1),
												),
							);
						yield* awaitTerminal(100);
						expect(
							yield* sql`SELECT id FROM carneloot.notification_deliveries WHERE event_id=${ambiguous.event}::uuid AND status='unknown'`,
						).toHaveLength(1);
						expect(
							yield* sql`SELECT id FROM carneloot.notification_events WHERE id=${ambiguous.event}::uuid AND status='completed'`,
						).toHaveLength(1);
						expect(
							yield* sql`SELECT id FROM tfx_restart_e2e.case_jobs WHERE id=${ambiguous.job}::uuid AND status='completed' AND outcome_json->>'_tag'='Succeeded'`,
						).toHaveLength(1);
					}),
				) as Effect.Effect<void, unknown, never>,
			);
			expect(sentC).toHaveLength(before);
		});

		it('proves representative migration attempt and stale-fence semantics', async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							Layer.merge(
								Layer.provide(
									TfxPostgres.layer({
										schema: config.tfxSchema,
										tablePrefix: config.tfxTablePrefix,
									}),
									postgres,
								),
								postgres,
							),
						);
						const store = yield* Effect.provide(JobStore, context);
						const scheduled = yield* store.schedule({
							name: 'representative',
							payload: {},
							payloadVersion: 1,
							maxAttempts: 3,
							runAt: DateTime.makeUnsafe(0),
							now: DateTime.makeUnsafe(0),
						});
						const first = (yield* store.claimForMigration(
							DateTime.makeUnsafe(1),
							Duration.millis(10),
						))!;
						expect(first.record.attempts).toBe(0);
						const running = yield* store.promoteToRunning(
							first.token,
							{},
							1,
							DateTime.makeUnsafe(2),
							Duration.millis(10),
						);
						expect(running.attempts).toBe(1);
						const takeover = (yield* store.claimForMigration(
							DateTime.makeUnsafe(13),
							Duration.millis(10),
						))!;
						const second = yield* store.promoteToRunning(
							takeover.token,
							{},
							1,
							DateTime.makeUnsafe(14),
							Duration.millis(10),
						);
						expect(second.attempts).toBe(2);
						expect(
							yield* store.finalize(
								first.token,
								{ _tag: 'Succeeded' },
								DateTime.makeUnsafe(15),
							),
						).toBe(false);
						expect(scheduled.record.id).toBe(second.id);
						for (const [payloadVersion, reason] of [
							[1, 'InvalidPayload'],
							[99, 'NewerPayloadVersion'],
						] as const) {
							const seeded = yield* store.schedule({
								name: 'feeding-reminder',
								payload: {},
								payloadVersion,
								maxAttempts: 8,
								runAt: DateTime.makeUnsafe(20),
								now: DateTime.makeUnsafe(20),
							});
							const claim = (yield* store.claimForMigration(
								DateTime.makeUnsafe(20),
								Duration.millis(10),
							))!;
							expect(claim.record.attempts).toBe(0);
							const quarantined = yield* store.quarantineMigration(
								claim.token,
								reason,
								DateTime.makeUnsafe(21),
							);
							expect(quarantined).toMatchObject({
								id: seeded.record.id,
								status: 'quarantined',
								attempts: 0,
							});
						}
						expect(
							(yield* store.problems()).filter(
								(job) => job.status === 'quarantined',
							),
						).toHaveLength(2);
					}),
				),
			);
		});
	});
