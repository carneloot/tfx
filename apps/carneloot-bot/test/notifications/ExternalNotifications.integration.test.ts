import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import { Telegram } from 'tfx/Telegram';
import {
	ForbiddenError,
	NetworkError,
	RateLimitError,
	TelegramError,
} from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import * as FakeTelegram from '../../../../packages/tfx/test/internal/FakeTelegram.js';
import { RecordedRequests } from '../../../../packages/tfx/test/internal/RecordedRequests.js';
import * as GenerateApiKey from '../../src/application/GenerateApiKey.js';
import * as RouteNotificationReply from '../../src/application/RouteNotificationReply.js';
import * as SendExternalNotification from '../../src/application/SendExternalNotification.js';
import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import * as Hosting from '../../src/http/Hosting.js';
import { ApiKeyRepository } from '../../src/ports/ApiKeyRepository.js';
import { ExternalNotificationRepository } from '../../src/ports/ExternalNotificationRepository.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../../src/ports/NotificationRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const chat = Schema.decodeUnknownSync(TelegramChatId);
const telegramId = Schema.decodeUnknownSync(TelegramUserId);
const uuid = Schema.decodeUnknownSync(EventId);
const register = Effect.fnUntraced(function* (id: number) {
	const users = yield* UserRepository;
	return yield* users.registerTelegramProfile({
		botId,
		telegramUserId: telegramId(id),
		privateChatId: chat(id),
		username: null,
		firstName: `User${id}`,
		lastName: null,
	});
});
const seed = Effect.gen(function* () {
	const owner = yield* register(1001);
	const subscriber = yield* register(1002);
	const sql = yield* PgClient.PgClient;
	const templateId = crypto.randomUUID();
	yield* sql`INSERT INTO carneloot.api_keys VALUES (${crypto.randomUUID()}::uuid,${owner.user.id}::uuid,${yield* GenerateApiKey.hash('imported-key')},now(),now())`;
	yield* sql`INSERT INTO carneloot.notification_templates VALUES (${templateId}::uuid,${owner.user.id}::uuid,'alarm','{{pet}} ate {{amount}}. {{pet}}!',now(),now())`;
	yield* sql`INSERT INTO carneloot.notification_subscriptions VALUES (${templateId}::uuid,${subscriber.user.id}::uuid,now()),(${templateId}::uuid,${owner.user.id}::uuid,now())`;
	return { owner, subscriber, templateId };
});
const input = {
	apiKey: 'imported-key',
	keyword: 'alarm',
	variables: { pet: 'Milo', amount: 20 },
};
const sent = (id: number) =>
	FakeTelegram.succeed('sendMessage', { message_id: id });
const failed = (reason: TelegramError['reason']) =>
	FakeTelegram.fail(
		'sendMessage',
		new TelegramError({ module: 'Telegram', method: 'sendMessage', reason }),
	);
const denied = () =>
	failed(
		new ForbiddenError({
			errorCode: 403,
			description: 'sensitive content must not escape',
		}),
	);
const ambiguous = () =>
	failed(new NetworkError({ message: 'sensitive transport content' }));
const testLayer = (scripts: ReadonlyArray<FakeTelegram.Script>) =>
	Layer.provideMerge(
		RepositoriesLive.layer,
		Layer.mergeAll(
			PostgresTestLayer.layer,
			NodeCrypto.layer,
			FakeTelegram.layer(scripts),
		),
	);
const run = <A, E>(
	effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof testLayer>>>,
	scripts: ReadonlyArray<FakeTelegram.Script> = [],
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer(scripts))));
const request = (body: unknown, path = '/api/notify', method = 'POST') =>
	new Request(`https://bot.test${path}`, {
		method,
		...(method === 'POST'
			? {
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}
			: {}),
	});
const http = Effect.fnUntraced(function* (
	body: unknown,
	path?: string,
	method?: string,
) {
	const context = yield* Effect.context<Hosting.Requirements>();
	return yield* Effect.promise(() =>
		Hosting.fetch(
			request(body, path, method),
			botId,
			Layer.succeedContext(context),
		),
	);
});

describe.skipIf(!enabled)('external notifications with real PostgreSQL', () => {
	it('authorizes imported rows, freezes repeated placeholders and recipients before output, and keeps exact history', async () => {
		await run(
			Effect.gen(function* () {
				const { templateId } = yield* seed;
				const sql = yield* PgClient.PgClient;
				const telegram = yield* Telegram;
				const response = yield* http(input).pipe(
					Effect.provideService(Telegram, {
						...telegram,
						sendMessage: (payload) =>
							Effect.gen(function* () {
								const snapshots =
									yield* sql`SELECT rendered_message,recipients_materialized_at FROM carneloot.notification_event_payloads p JOIN carneloot.notification_events e ON e.id=p.event_id`.pipe(
										Effect.orDie,
									);
								expect(snapshots).toEqual([
									{
										rendered_message: 'Milo ate 20. Milo!',
										recipients_materialized_at: expect.any(Date),
									},
								]);
								expect(
									yield* sql`SELECT id FROM carneloot.notification_deliveries`.pipe(
										Effect.orDie,
									),
								).toHaveLength(2);
								return yield* telegram.sendMessage(payload);
							}),
					}),
				);
				expect(response.status).toBe(200);
				const result = yield* Effect.promise(() => response.json());
				expect(result).toMatchObject({
					status: 'sent',
					counts: { sent: 2, failed: 0, unknown: 0 },
					failures: [],
				});
				const external = yield* ExternalNotificationRepository;
				yield* sql`UPDATE carneloot.notification_templates SET message='changed' WHERE id=${templateId}::uuid`;
				yield* sql`DELETE FROM carneloot.notification_subscriptions WHERE template_id=${templateId}::uuid`;
				expect(yield* external.payload(uuid(result.eventId))).toEqual({
					text: 'Milo ate 20. Milo!',
					replyToMessageId: null,
				});
				const rows =
					yield* sql`SELECT d.status,d.attempt_count,d.telegram_message_id,e.recipients_materialized_at,e.status AS event_status FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.id=${result.eventId}::uuid`;
				expect(rows).toHaveLength(2);
				for (const row of rows)
					expect(row).toMatchObject({
						status: 'sent',
						attempt_count: 1,
						event_status: 'completed',
						recipients_materialized_at: expect.any(Date),
					});
				const recorded = yield* RecordedRequests;
				expect(
					(yield* recorded.method('sendMessage')).map((r) => r.input),
				).toEqual(
					expect.arrayContaining([
						{ chat_id: 1001, text: 'Milo ate 20. Milo!' },
						{ chat_id: 1002, text: 'Milo ate 20. Milo!' },
					]),
				);
			}),
			[sent(11), sent(12)],
		);
	});

	it.each([
		[
			'partial known failures',
			[sent(21), denied()],
			207,
			{ sent: 1, failed: 1, unknown: 0 },
		],
		[
			'partial unknown',
			[sent(21), ambiguous()],
			207,
			{ sent: 1, failed: 0, unknown: 1 },
		],
		[
			'all failed',
			[denied(), denied()],
			502,
			{ sent: 0, failed: 2, unknown: 0 },
		],
		[
			'all ambiguous',
			[ambiguous(), ambiguous()],
			202,
			{ sent: 0, failed: 0, unknown: 2 },
		],
		[
			'rate limited, no implicit retry',
			[
				failed(
					new RateLimitError({
						errorCode: 429,
						description: 'retry',
						retryAfterSeconds: 1,
					}),
				),
				denied(),
			],
			502,
			{ sent: 0, failed: 2, unknown: 0 },
		],
	] as const)(
		'returns exact HTTP outcomes for %s',
		async (_, scripts, status, counts) => {
			await run(
				Effect.gen(function* () {
					yield* seed;
					const response = yield* http(input);
					expect(response.status).toBe(status);
					const result = yield* Effect.promise(() => response.json());
					expect(result.counts).toEqual(counts);
					expect(JSON.stringify(result)).not.toContain('sensitive');
					const notifications = yield* NotificationRepository;
					expect(
						yield* notifications.claimNext(
							uuid(result.eventId),
							yield* DateTime.now,
							Duration.seconds(30),
						),
					).toBeUndefined();
					const sql = yield* PgClient.PgClient;
					const rows =
						yield* sql`SELECT status,retryable FROM carneloot.notification_deliveries WHERE event_id=${result.eventId}::uuid`;
					expect(
						rows.every(
							(row) => row.status !== 'sending' && row.retryable === false,
						),
					).toBe(true);
				}),
				scripts,
			);
		},
	);

	it('returns distinct invalid key/template errors, 422 missing variables, 400 decode, and exposes no management routes', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				for (const [body, status, tag] of [
					[{ ...input, apiKey: 'wrong' }, 404, 'InvalidApiKey'],
					[{ ...input, keyword: 'missing' }, 404, 'TemplateNotFound'],
					[
						{ ...input, variables: { pet: 'Milo' } },
						422,
						'MissingTemplateVariables',
					],
				] as const) {
					const response = yield* http(body);
					expect(response.status).toBe(status);
					expect(yield* Effect.promise(() => response.json())).toMatchObject({
						_tag: tag,
					});
				}
				const bad = yield* http({
					...input,
					variables: { pet: { secret: 'do-not-echo' } },
				});
				expect(bad.status).toBe(400);
				expect(yield* Effect.promise(() => bad.text())).not.toContain(
					'do-not-echo',
				);
				for (const path of [
					'/api/templates',
					'/api/subscriptions',
					'/api/webhook/set',
				])
					expect((yield* http({}, path)).status).toBe(404);
				expect((yield* http({}, '/api/notify', 'GET')).status).toBe(404);
				const recorded = yield* RecordedRequests;
				expect(yield* recorded.count()).toBe(0);
			}),
		);
	});

	it('rejects missing-chat recipients durably and never attempts them', async () => {
		await run(
			Effect.gen(function* () {
				const { subscriber } = yield* seed;
				const sql = yield* PgClient.PgClient;
				yield* sql`DELETE FROM carneloot.telegram_identities WHERE user_id=${subscriber.user.id}::uuid`;
				const result = yield* SendExternalNotification.execute(botId, input);
				expect(result).toMatchObject({
					status: 'partial',
					counts: { sent: 1, failed: 1, unknown: 0 },
				});
				const recorded = yield* RecordedRequests;
				expect(yield* recorded.count()).toBe(1);
			}),
			[sent(25)],
		);
	});

	it('rolls back event and payload if initial recipient persistence fails, sends nothing, returns 503', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(
					`CREATE FUNCTION carneloot.reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$`,
				);
				yield* sql.unsafe(
					`CREATE TRIGGER reject_delivery BEFORE INSERT ON carneloot.notification_deliveries FOR EACH ROW EXECUTE FUNCTION carneloot.reject_delivery()`,
				);
				const response = yield* http(input);
				expect(response.status).toBe(503);
				expect(
					yield* sql`SELECT id FROM carneloot.notification_events`,
				).toHaveLength(0);
				expect(
					yield* sql`SELECT event_id FROM carneloot.notification_event_payloads`,
				).toHaveLength(0);
				const recorded = yield* RecordedRequests;
				expect(yield* recorded.count()).toBe(0);
			}),
		);
	});

	it('persists unknown after an accepted send whose finalization fails and never returns 503', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(
					`CREATE FUNCTION carneloot.reject_sent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='sent' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$`,
				);
				yield* sql.unsafe(
					`CREATE TRIGGER reject_sent BEFORE UPDATE ON carneloot.notification_deliveries FOR EACH ROW EXECUTE FUNCTION carneloot.reject_sent()`,
				);
				const response = yield* http(input);
				expect(response.status).toBe(202);
				const result = yield* Effect.promise(() => response.json());
				expect(result.counts).toEqual({ sent: 0, failed: 0, unknown: 2 });
				const rows =
					yield* sql`SELECT status,attempt_count FROM carneloot.notification_deliveries WHERE event_id=${result.eventId}::uuid`;
				expect(rows).toEqual([
					{ status: 'unknown', attempt_count: 1 },
					{ status: 'unknown', attempt_count: 1 },
				]);
			}),
			[sent(31), sent(32)],
		);
	});

	it('retains confirmed outcomes when the post-send reread fails, and marks unresolved recipients unknown', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				const repository = yield* ExternalNotificationRepository;
				const response = yield* http(input).pipe(
					Effect.provideService(ExternalNotificationRepository, {
						...repository,
						result: () =>
							Effect.fail(
								new NotificationRepositoryError({
									reason: 'PersistenceFailure',
									message: 'test',
								}),
							),
					}),
				);
				expect(response.status).toBe(207);
				expect(yield* Effect.promise(() => response.json())).toMatchObject({
					counts: { sent: 1, failed: 0, unknown: 1 },
				});
			}),
			[sent(41), ambiguous()],
		);
	});

	it('issues only hashed keys, requires confirmation to replace, revokes the previous key, and reauthorizes the actor', async () => {
		await run(
			Effect.gen(function* () {
				const owner = yield* register(1001);
				const other = yield* register(1002);
				const actor = {
					botId,
					actorId: owner.user.id,
					telegramUserId: telegramId(1001),
					confirmed: false,
				};
				const first = yield* GenerateApiKey.execute(actor);
				if (first._tag !== 'Issued')
					return yield* Effect.die('expected first key');
				const keys = yield* ApiKeyRepository;
				expect(
					yield* keys.findOwner(yield* GenerateApiKey.hash(first.key)),
				).toBe(owner.user.id);
				expect(yield* GenerateApiKey.execute(actor)).toEqual({
					_tag: 'ConfirmationRequired',
				});
				const rejected = yield* Effect.result(
					GenerateApiKey.execute({
						...actor,
						actorId: other.user.id,
						confirmed: true,
					}),
				);
				expect(rejected).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'InvalidDomainInput' },
				});
				const replacement = yield* GenerateApiKey.execute({
					...actor,
					confirmed: true,
				});
				if (replacement._tag !== 'Issued')
					return yield* Effect.die('expected replacement');
				expect(replacement.key).not.toBe(first.key);
				expect(
					yield* keys.findOwner(yield* GenerateApiKey.hash(first.key)),
				).toBeUndefined();
				expect(
					yield* keys.findOwner(yield* GenerateApiKey.hash(replacement.key)),
				).toBe(owner.user.id);
				const sql = yield* PgClient.PgClient;
				const rows =
					yield* sql`SELECT key_hash FROM carneloot.api_keys WHERE user_id=${owner.user.id}::uuid`;
				expect(rows).toEqual([
					{ key_hash: yield* GenerateApiKey.hash(replacement.key) },
				]);
				expect(JSON.stringify(rows)).not.toContain(replacement.key);
			}),
		);
	});

	it('routes only the exact subscriber/chat/event to the corresponding owner message; rejects self/spoofed replies', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				const first = yield* SendExternalNotification.execute(botId, input);
				yield* SendExternalNotification.execute(botId, input);
				const sql = yield* PgClient.PgClient;
				const deliveries =
					yield* sql`SELECT recipient_chat_id,telegram_message_id FROM carneloot.notification_deliveries WHERE event_id=${first.eventId}::uuid`;
				const subscriber = deliveries.find(
					(row) => Number(row.recipient_chat_id) === 1002,
				);
				const owner = deliveries.find(
					(row) => Number(row.recipient_chat_id) === 1001,
				);
				if (subscriber === undefined || owner === undefined)
					return yield* Effect.die('missing history');
				const reply = {
					botId,
					chatId: chat(1002),
					telegramUserId: telegramId(1002),
					repliedMessageId: Number(subscriber.telegram_message_id),
					updateId: 50,
					text: 'Thanks',
				};
				expect(
					yield* RouteNotificationReply.execute({
						...reply,
						chatId: chat(9999),
					}),
				).toEqual({ _tag: 'Unrelated' });
				expect(
					yield* RouteNotificationReply.execute({
						...reply,
						chatId: chat(9999),
						telegramUserId: telegramId(9999),
					}),
				).toEqual({ _tag: 'Unrelated' });
				expect(
					yield* RouteNotificationReply.execute({
						...reply,
						telegramUserId: telegramId(1001),
					}),
				).toMatchObject({ _tag: 'Rejected' });
				expect(
					yield* RouteNotificationReply.execute({
						...reply,
						chatId: chat(1001),
						telegramUserId: telegramId(1001),
						repliedMessageId: Number(owner.telegram_message_id),
					}),
				).toMatchObject({
					_tag: 'Rejected',
					message: 'Você não pode responder a sua própria notificação.',
				});
				expect(yield* RouteNotificationReply.execute(reply)).toEqual({
					_tag: 'Routed',
					status: 'sent',
				});
				yield* RouteNotificationReply.execute({
					...reply,
					text: 'Changed replay',
				});
				const recorded = yield* RecordedRequests;
				const requests = yield* recorded.method('sendMessage');
				expect(requests).toHaveLength(5);
				expect(requests[4]?.input).toEqual({
					chat_id: 1001,
					text: 'User1002: Thanks',
					reply_parameters: { message_id: Number(owner.telegram_message_id) },
				});
			}),
			[sent(101), sent(102), sent(103), sent(104), sent(105)],
		);
	});

	it('never resends an ambiguous forwarded reply on update replay', async () => {
		await run(
			Effect.gen(function* () {
				yield* seed;
				const event = yield* SendExternalNotification.execute(botId, input);
				const sql = yield* PgClient.PgClient;
				const rows =
					yield* sql`SELECT telegram_message_id FROM carneloot.notification_deliveries WHERE event_id=${event.eventId}::uuid AND recipient_chat_id=1002`;
				const reply = {
					botId,
					chatId: chat(1002),
					telegramUserId: telegramId(1002),
					repliedMessageId: Number(rows[0]?.telegram_message_id),
					updateId: 51,
					text: 'Thanks',
				};
				expect(yield* RouteNotificationReply.execute(reply)).toMatchObject({
					_tag: 'Routed',
					status: 'unknown',
				});
				yield* RouteNotificationReply.execute(reply);
				const recorded = yield* RecordedRequests;
				expect(yield* recorded.count()).toBe(3);
			}),
			[sent(201), sent(202), ambiguous()],
		);
	});
});
