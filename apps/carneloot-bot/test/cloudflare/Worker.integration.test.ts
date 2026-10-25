import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as PgClient from '@effect/sql-pg/PgClient';
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import * as Migrations from '@tfx/postgres/Migrations';
import * as PostgresJobStore from '@tfx/postgres/PostgresJobStore';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Scope from 'effect/Scope';
import { build } from 'esbuild';
import {
	Miniflare,
	type MiniflareOptions,
	type Request as MockRequest,
	Response as MockResponse,
} from 'miniflare';
import { JobStore } from 'tfx/JobStore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as AppMigrator from '../../src/postgres/AppMigrator.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const options = {
	schema: 'tfx_cloudflare_test',
	tablePrefix: 'bot_',
	botId: 'carneloot',
};
const secret = 'local-test-secret-not-a-live-token-123456';
const messageTime = 1_735_787_400;
const update = (id: number, text: string) => ({
	update_id: id,
	message: {
		message_id: id,
		date: messageTime + id * 61,
		from: { id: 8123, is_bot: false, first_name: 'Owner' },
		chat: { id: 8123, type: 'private', first_name: 'Owner' },
		text,
		...(text.startsWith('/')
			? {
					entities: [
						{
							type: 'bot_command',
							offset: 0,
							length: text.split(' ')[0]!.length,
						},
					],
				}
			: {}),
	},
});

describe.skipIf(!enabled)(
	'Cloudflare Worker with real workerd and PostgreSQL',
	() => {
		let container: StartedPostgreSqlContainer | undefined;
		let emulator: Miniflare;
		let emulatorOptions: MiniflareOptions;
		const storageScope = Effect.runSync(Scope.make());
		let workers: Awaited<ReturnType<Miniflare['getWorker']>>[] = [];
		let postgres: ReturnType<typeof PgClient.layer<never>>;
		let sends = 0;
		let failOutput = false;
		let slowOutput = false;
		let slowStarted: (() => void) | undefined;
		const runtimeRole = `tfx_cloudflare_runtime_${process.pid}`;
		let roleCreated = false;
		const post = (worker: (typeof workers)[number], value: unknown) =>
			worker.fetch('https://bot.test/telegram', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify(value),
			});
		const query = <A>(sql: string) =>
			Effect.runPromise(
				Effect.flatMap(PgClient.PgClient, (client) =>
					client.unsafe<A & object>(sql),
				).pipe(Effect.provide(postgres)),
			);
		const cron = () => workers[0]!.scheduled({ cron: '* * * * *' });
		const wakeup = async (path: string) => {
			const namespace = await emulator.getDurableObjectNamespace(
				'JOB_WAKEUP',
				'host',
			);
			return namespace
				.get(namespace.idFromName('carneloot'))
				.fetch(`https://wakeup.test${path}`);
		};

		beforeAll(async () => {
			const url =
				process.env.TEST_DATABASE_URL ??
				(container = await new PostgreSqlContainer(
					'postgres:17-alpine',
				).start()).getConnectionUri();
			postgres = PgClient.layer({ url: Redacted.make(url), prepare: false });
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient;
					yield* sql.unsafe('DROP SCHEMA IF EXISTS carneloot CASCADE');
					yield* sql.unsafe(
						'DROP SCHEMA IF EXISTS tfx_cloudflare_test CASCADE',
					);
					yield* Migrations.migrate(options);
					yield* AppMigrator.migrate;
				}).pipe(Effect.provide(postgres)),
			);
			// Production cannot migrate: no DDL privileges or migration-ledger access.
			await query(
				`CREATE ROLE ${runtimeRole} LOGIN PASSWORD 'local-runtime-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
			);
			roleCreated = true;
			await query(
				`GRANT USAGE ON SCHEMA carneloot,tfx_cloudflare_test TO ${runtimeRole}`,
			);
			await query(
				`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA carneloot,tfx_cloudflare_test TO ${runtimeRole}`,
			);
			await query(
				`REVOKE ALL ON carneloot.app_migrations,tfx_cloudflare_test.bot_migrations FROM ${runtimeRole}`,
			);
			const runtimeUrl = new URL(url);
			runtimeUrl.username = runtimeRole;
			runtimeUrl.password = 'local-runtime-test-only';
			const result = await build({
				entryPoints: ['apps/carneloot-bot/test/cloudflare/Worker.ts'],
				bundle: true,
				write: false,
				format: 'esm',
				platform: 'node',
				target: 'es2024',
				external: ['node:*'],
			});
			const script = result.outputFiles[0]!.text;
			const storagePath = await Effect.runPromise(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					return yield* fs.makeTempDirectoryScoped({
						prefix: 'tfx-cloudflare-',
					});
				}).pipe(
					Effect.provideService(Scope.Scope, storageScope),
					Effect.provide(NodeFileSystem.layer),
				),
			);
			emulatorOptions = {
				durableObjectsPersist: storagePath,
				workers: ['host', 'gateway'].map((name) => ({
					name,
					modules: true,
					script,
					compatibilityDate: '2026-07-30',
					compatibilityFlags: ['nodejs_compat'],
					hyperdrives: { HYPERDRIVE: runtimeUrl.href },
					outboundService: async (request: MockRequest) => {
						const target = new URL(request.url);
						expect(target.origin).toBe('https://api.telegram.org');
						const payload = (await request.json()) as {
							chat_id: number;
							text: string;
						};
						if (!target.pathname.endsWith('/sendMessage'))
							return MockResponse.json({ ok: true, result: true });
						sends++;
						if (slowOutput && payload.text === 'Qual o nome do seu pet?') {
							slowStarted?.();
							await new Promise((resolve) => setTimeout(resolve, 6_000));
						}
						if (failOutput)
							return MockResponse.json({
								ok: false,
								error_code: 403,
								description: 'Forbidden',
							});
						return MockResponse.json({
							ok: true,
							result: {
								message_id: sends,
								date: messageTime,
								chat: { id: payload.chat_id, type: 'private' },
								text: payload.text,
							},
						});
					},
					durableObjects: {
						CHAT_DISPATCH: { className: 'ChatDispatch', scriptName: 'host' },
						JOB_WAKEUP: { className: 'JobWakeup', scriptName: 'host' },
					},
					bindings: {
						BOT_TOKEN: 'test-token',
						BOT_USERNAME: 'carneloot_bot',
						WEBHOOK_SECRET: secret,
						TFX_POSTGRES_SCHEMA: options.schema,
						TFX_POSTGRES_TABLE_PREFIX: options.tablePrefix,
					},
				})),
			};
			emulator = new Miniflare(emulatorOptions);
			workers = await Promise.all(
				['host', 'gateway'].map((name) => emulator.getWorker(name)),
			);
		}, 60_000);

		afterAll(async () => {
			try {
				await emulator?.dispose();
			} finally {
				await Effect.runPromise(Scope.close(storageScope, Exit.void));
			}
			if (roleCreated) {
				await query(`DROP OWNED BY ${runtimeRole}`);
				await query(`DROP ROLE ${runtimeRole}`);
			}
			await container?.stop();
		});

		it('rejects unauthenticated, malformed and oversized bodies before dispatch', async () => {
			expect((await workers[0]!.fetch('https://bot.test/health')).status).toBe(
				200,
			);
			expect(
				(
					await workers[0]!.fetch('https://bot.test/telegram', {
						method: 'POST',
						body: '{}',
					})
				).status,
			).toBe(403);
			expect((await post(workers[0]!, { update_id: -1 })).status).toBe(400);
			expect(
				(
					await workers[0]!.fetch('https://bot.test/telegram', {
						method: 'POST',
						headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
						body: 'x'.repeat(1_048_577),
					})
				).status,
			).toBe(413);
			expect(
				await query(
					'SELECT count(*)::int AS count FROM tfx_cloudflare_test.bot_update_deduplication',
				),
			).toEqual([{ count: 0 }]);
		});

		it('preserves persisted conversations, multi-pet replay and message-time food across independent requests', async () => {
			let id = 100;
			const send = async (text: string) =>
				expect((await post(workers[id % 2]!, update(id++, text))).status).toBe(
					200,
				);
			await send('/cadastrar');
			await send('/adicionar_pet');
			const nameUpdate = update(id++, 'Rex');
			expect(
				(
					await Promise.all(workers.map((worker) => post(worker, nameUpdate)))
				).map((response) => response.status),
			).toEqual([200, 200]);
			await send('/adicionar_pet');
			await send('Mimi');
			for (const pet of ['Rex', 'Mimi'])
				for (const text of [
					'/configurar_inicio_dia',
					pet,
					'Alterar',
					'0h',
					'America/Sao_Paulo',
				])
					await send(text);
			const foodUpdate = update(id++, '/todos 50g');
			expect(
				(
					await Promise.all(workers.map((worker) => post(worker, foodUpdate)))
				).map((response) => response.status),
			).toEqual([200, 200]);
			const beforeReplay = sends;
			expect((await post(workers[1]!, foodUpdate)).status).toBe(200);
			expect(sends).toBe(beforeReplay);
			expect(
				await query<{ amount: number; fed_at: Date; update: number }>(
					`SELECT amount_mg::int AS amount,fed_at,source_update_id::int AS update FROM carneloot.pet_food_entries ORDER BY pet_id`,
				),
			).toEqual(
				Array.from({ length: 2 }, () => ({
					amount: 50_000,
					fed_at: new Date(foodUpdate.message.date * 1000),
					update: foodUpdate.update_id,
				})),
			);
			const concurrent = await Promise.all([
				post(workers[0]!, {
					...update(id, '/todos 37g'),
					message: {
						...update(id++, '/todos 37g').message,
						chat: { id: -8124, type: 'group', title: 'Other chat' },
					},
				}),
				post(workers[1]!, {
					...update(id, '/todos 21g'),
					message: {
						...update(id++, '/todos 21g').message,
						chat: { id: -8125, type: 'group', title: 'Third chat' },
					},
				}),
			]);
			expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
			expect(
				await query(
					'SELECT count(*)::int AS count,sum(amount_mg)::int AS total FROM carneloot.pet_food_entries',
				),
			).toEqual([{ count: 6, total: 216_000 }]);
			failOutput = true;
			const outputFailure = update(id++, '/todos 19g');
			expect((await post(workers[0]!, outputFailure)).status).toBe(200);
			const afterFailure = sends;
			expect((await post(workers[1]!, outputFailure)).status).toBe(200);
			expect(sends).toBe(afterFailure);
			failOutput = false;
			expect(
				await query(
					'SELECT count(*)::int AS count FROM carneloot.pet_food_entries',
				),
			).toEqual([{ count: 8 }]);
		});

		it('holds the native chat gate after disconnect until output timeout settles, then deduplicates the original command', async () => {
			slowOutput = true;
			const entered = new Promise<void>((resolve) => {
				slowStarted = resolve;
			});
			const command = update(1_000, '/adicionar_pet');
			const controller = new AbortController();
			const disconnected = fetch(new URL('/telegram', await emulator.ready), {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
				body: JSON.stringify(command),
				signal: controller.signal,
			}).catch(() => undefined);
			await entered;
			controller.abort();
			slowOutput = false;
			const started = Date.now();
			expect(
				(await post(workers[1]!, update(1_001, 'After output timeout'))).status,
			).toBe(200);
			expect(Date.now() - started).toBeGreaterThan(4_000);
			await disconnected;
			const beforeRetry = sends;
			expect((await post(workers[0]!, command)).status).toBe(200);
			expect(sends).toBe(beforeRetry);
			expect(
				await query(
					'SELECT count(*)::int AS count FROM tfx_cloudflare_test.bot_conversations',
				),
			).toEqual([{ count: 0 }]);
			expect(
				await query(
					"SELECT name FROM carneloot.pets WHERE name='After output timeout'",
				),
			).toEqual([{ name: 'After output timeout' }]);
			expect(
				await query(
					'SELECT outcome_json FROM tfx_cloudflare_test.bot_update_deduplication WHERE update_id=1000',
				),
			).toEqual([
				{
					outcome_json: {
						_tag: 'HandledWithOutputFailure',
						error: 'conversation-output-failed',
					},
				},
			]);
		});

		it('awaits deadline rollback and claim cleanup before a distinct following conversation input', async () => {
			await query(
				`CREATE FUNCTION carneloot.slow_pet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='Blocked input' THEN PERFORM pg_sleep(20); END IF; RETURN NEW; END $$`,
			);
			await query(
				'CREATE TRIGGER slow_pet BEFORE INSERT ON carneloot.pets FOR EACH ROW EXECUTE FUNCTION carneloot.slow_pet()',
			);
			try {
				expect(
					(await post(workers[0]!, update(2_000, '/adicionar_pet'))).status,
				).toBe(200);
				const blocked = post(workers[0]!, update(2_001, 'Blocked input'));
				await expect
					.poll(
						async () =>
							query(
								`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='${runtimeRole}' AND wait_event='PgSleep'`,
							),
						{ timeout: 5_000 },
					)
					.toEqual([{ count: 1 }]);
				const following = post(workers[1]!, update(2_002, 'After rollback'));
				expect((await blocked).status).toBe(503);
				expect((await following).status).toBe(200);
				expect(
					await query(
						"SELECT name FROM carneloot.pets WHERE name IN ('Blocked input','After rollback')",
					),
				).toEqual([{ name: 'After rollback' }]);
				expect(
					await query(
						'SELECT status FROM tfx_cloudflare_test.bot_update_deduplication WHERE update_id=2001',
					),
				).toEqual([{ status: 'released' }]);
				expect(
					(await post(workers[0]!, update(2_001, 'Blocked input'))).status,
				).toBe(200);
				expect(
					await query(
						"SELECT count(*)::int AS count FROM carneloot.pets WHERE name='Blocked input'",
					),
				).toEqual([{ count: 0 }]);
			} finally {
				await query('DROP TRIGGER slow_pet ON carneloot.pets');
				await query('DROP FUNCTION carneloot.slow_pet()');
			}
		});

		it('delivers a persisted reminder from a native alarm once, including duplicate wakeups', async () => {
			let id = 3_000;
			for (const text of [
				'/configurar_atraso_notificacao',
				'Rex',
				'Definir',
				'1 minuto',
			])
				expect((await post(workers[id % 2]!, update(id++, text))).status).toBe(
					200,
				);
			const before = sends;
			expect((await post(workers[0]!, update(id++, '/todos 29g'))).status).toBe(
				200,
			);
			await expect
				.poll(
					() =>
						query(
							"SELECT d.status FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.kind='feeding-reminder'",
						),
					{ timeout: 5_000 },
				)
				.toEqual([{ status: 'sent' }]);
			// One command response and one reminder, not two reminder sends.
			expect(sends - before).toBe(2);
			expect((await wakeup('/alarm')).status).toBe(200);
			expect((await wakeup('/alarm')).status).toBe(200);
			expect(sends - before).toBe(2);
		});

		it('recovers ambiguous sending as unknown and a missed post-commit handoff without cron executing jobs', async () => {
			await query(`INSERT INTO carneloot.notification_events
			(id,bot_id,kind,owner_user_id,pet_id,food_entry_id,status,dedupe_key,created_at,updated_at)
			SELECT gen_random_uuid(),'carneloot','feeding-reminder',p.owner_id,p.id,f.id,'scheduled','cloudflare-expired-send-test',now(),now()
			FROM carneloot.pet_food_entries f JOIN carneloot.pets p ON p.id=f.pet_id ORDER BY f.id LIMIT 1`);
			await query(`INSERT INTO carneloot.notification_deliveries
			(id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_count,attempt_generation,sending_started_at,sending_lease_expires_at,created_at,updated_at)
			SELECT gen_random_uuid(),id,owner_user_id,8123,'owner','telegram','sending',1,1,now()-interval '2 minutes',now()-interval '1 minute',now(),now()
			FROM carneloot.notification_events WHERE dedupe_key='cloudflare-expired-send-test'`);
			const before = sends;
			expect((await cron()).outcome).toBe('ok');
			expect(
				await query(
					"SELECT d.status,d.retryable FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.dedupe_key='cloudflare-expired-send-test'",
				),
			).toEqual([{ status: 'unknown', retryable: false }]);
			expect(sends).toBe(before);
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* JobStore;
					const now = yield* DateTime.now;
					for (let i = 0; i < 55; i++)
						yield* store.schedule({
							name: 'unknown-cloudflare-test-job',
							payload: {},
							payloadVersion: 1,
							maxAttempts: 1,
							now,
							runAt: now,
						});
				}).pipe(
					Effect.provide(
						Layer.provide(
							PostgresJobStore.layer(options),
							Layer.merge(postgres, NodeCrypto.layer),
						),
					),
				),
			);
			const started = Date.now();
			expect((await cron()).outcome).toBe('ok');
			expect(Date.now() - started).toBeLessThan(10_000);
			await expect
				.poll(
					() =>
						query(
							"SELECT count(*)::int AS count FROM tfx_cloudflare_test.bot_jobs WHERE declaration='unknown-cloudflare-test-job' AND status='quarantined'",
						),
					{ timeout: 10_000 },
				)
				.toEqual([{ count: 55 }]);
			expect(sends).toBe(before);
		});

		it('keeps a committed reminder and its outbox when native handoff fails, then recovers without replaying output', async () => {
			expect((await wakeup('/fail-next-handoff')).status).toBe(200);
			const before = sends;
			const food = update(4000, '/todos 31g');
			expect((await post(workers[0]!, food)).status).toBe(200);
			expect(sends - before).toBe(1);
			expect(
				await query(
					'SELECT count(*)::int AS count FROM tfx_cloudflare_test.bot_job_wakeups',
				),
			).toEqual([{ count: 1 }]);
			expect(await (await wakeup('/state')).json()).toEqual({ alarm: null });
			expect((await cron()).outcome).toBe('ok');
			await expect
				.poll(
					() =>
						query(
							"SELECT count(*)::int AS count FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.kind='feeding-reminder' AND d.status='sent'",
						),
					{ timeout: 5000 },
				)
				.toEqual([{ count: 2 }]);
			expect(sends - before).toBe(2);
			expect((await post(workers[1]!, food)).status).toBe(200);
			expect(sends - before).toBe(2);
		});

		it('replaces and cancels schedules, then survives an isolate restart with only the earliest SQL deadline armed', async () => {
			const ids = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* JobStore;
					const now = yield* DateTime.now;
					const request = {
						name: 'restart-test',
						payload: {},
						payloadVersion: 1,
						maxAttempts: 1,
						now,
						conflictKey: 'pet-1',
					};
					const first = yield* store.schedule({
						...request,
						runAt: DateTime.addDuration(now, '1 hour'),
					});
					const replacement = yield* store.schedule({
						...request,
						runAt: DateTime.addDuration(now, '4 seconds'),
					});
					const cancelled = yield* store.schedule({
						...request,
						conflictKey: 'pet-2',
						runAt: now,
					});
					yield* store.cancel(cancelled.record.id, now);
					const interrupted = yield* store.schedule({
						...request,
						name: 'interrupted-test',
						runAt: now,
						maxAttempts: 2,
					});
					const claim = yield* store.claimForMigration(
						now,
						Duration.seconds(5),
					);
					if (claim?.record.id !== interrupted.record.id)
						throw new Error('Expected interrupted job claim');
					yield* store.promoteToRunning(
						claim.token,
						{},
						1,
						now,
						Duration.seconds(5),
					);
					return {
						first: first.record.id,
						replacement: replacement.record.id,
						cancelled: cancelled.record.id,
						deadline: DateTime.toEpochMillis(replacement.record.runAt),
						interrupted: interrupted.record.id,
					};
				}).pipe(
					Effect.provide(
						Layer.provide(PostgresJobStore.layer(options), postgres),
					),
				),
			);
			expect((await cron()).outcome).toBe('ok');
			expect(await (await wakeup('/state')).json()).toEqual({
				alarm: ids.deadline,
			});
			await emulator.dispose();
			emulator = new Miniflare(emulatorOptions);
			workers = await Promise.all(
				['host', 'gateway'].map((name) => emulator.getWorker(name)),
			);
			await expect
				.poll(
					() =>
						query(
							`SELECT status FROM tfx_cloudflare_test.bot_jobs WHERE id='${ids.replacement}'`,
						),
					{ timeout: 10_000 },
				)
				.toEqual([{ status: 'quarantined' }]);
			expect(
				await query(
					`SELECT status FROM tfx_cloudflare_test.bot_jobs WHERE id IN ('${ids.first}','${ids.cancelled}')`,
				),
			).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
			await expect
				.poll(
					() =>
						query(
							`SELECT status,attempts FROM tfx_cloudflare_test.bot_jobs WHERE id='${ids.interrupted}'`,
						),
					{ timeout: 5000 },
				)
				.toEqual([{ status: 'quarantined', attempts: 1 }]);
			expect((await wakeup('/alarm')).status).toBe(200);
			expect(await (await wakeup('/state')).json()).toEqual({ alarm: null });
		});
	},
);
