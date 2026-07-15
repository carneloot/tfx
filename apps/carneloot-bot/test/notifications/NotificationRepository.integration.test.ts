import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import * as RecipientRole from '../../src/domain/notifications/RecipientRole.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as NotificationRepositoryLive from '../../src/postgres/NotificationRepositoryLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	Layer.merge(NotificationRepositoryLive.layer, UserRepositoryLive.layer),
	PostgresTestLayer.layer,
);
const eventId = () => Schema.decodeUnknownSync(EventId)(crypto.randomUUID());
const deliveryId = () =>
	Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID());
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const register = (suffix: string, telegramId: number) =>
	Effect.flatMap(UserRepository, (users) =>
		users.registerTelegramProfile({
			botId,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
			username: null,
			firstName: suffix,
			lastName: null,
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
		}),
	);
const create = (
	repository: typeof NotificationRepository.Service,
	ownerUserId: any,
	suffix: string,
	now = 1_000,
) =>
	repository.createEvent({
		id: eventId(),
		botId,
		kind: 'feeding-reminder',
		ownerUserId,
		petId: null,
		foodEntryId: null,
		scheduledFor: now,
		dedupeKey: `notification-${suffix}-${crypto.randomUUID()}`,
		now,
	});

if (!enabled)
	describe.skip('notification repository PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('notification repository PostgreSQL', () => {
		it('deduplicates events and materializes recipients idempotently', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`owner-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 1,
				);
				const repository = yield* NotificationRepository;
				const id = eventId();
				const input = {
					id,
					botId,
					kind: 'feeding-reminder',
					ownerUserId: owner.user.id,
					petId: null,
					foodEntryId: null,
					scheduledFor: 1_000,
					dedupeKey: `dedupe-${crypto.randomUUID()}`,
					now: 1_000,
				} as const;
				const first = yield* repository.createEvent(input);
				const repeated = yield* repository.createEvent({
					...input,
					id: eventId(),
				});
				const conflicting = yield* Effect.result(
					repository.createEvent({
						...input,
						id: eventId(),
						kind: 'unrelated-kind',
					}),
				);
				const recipient = {
					_tag: 'Reachable' as const,
					id: deliveryId(),
					recipientUserId: owner.user.id,
					recipientChatId: owner.profile.privateChatId,
					recipientRole: RecipientRole.owner,
					channel: 'telegram',
				} as const;
				const a = yield* repository.materializeRecipients(
					first.id,
					[recipient],
					1_000,
				);
				const b = yield* repository.materializeRecipients(
					first.id,
					[{ ...recipient, id: deliveryId() }],
					1_001,
				);
				const unreachable = yield* repository.materializeRecipients(
					first.id,
					[
						{
							_tag: 'Unreachable',
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientRole: RecipientRole.subscriber,
							channel: 'telegram-unreachable',
							error: {
								code: 'MissingTelegramIdentity',
								message: 'No identity',
							},
						},
					],
					1_001,
				);
				const attached = yield* repository.attachJob(
					first.id,
					crypto.randomUUID(),
					1_002,
				);
				const attachedTwice = yield* repository.attachJob(
					first.id,
					crypto.randomUUID(),
					1_003,
				);
				const cancelled = yield* repository.cancelEvent(first.id, 1_004);
				const context = yield* repository.getDispatchContext(first.id);
				const materializeCancelled = yield* Effect.result(
					repository.materializeRecipients(
						first.id,
						[{ ...recipient, id: deliveryId(), channel: 'telegram-backup' }],
						1_005,
					),
				);
				const claimCancelled = yield* repository.claimNext(
					first.id,
					1_005,
					100,
				);
				return {
					first,
					repeated,
					conflicting,
					a,
					b,
					unreachable,
					attached,
					attachedTwice,
					cancelled,
					context,
					materializeCancelled,
					claimCancelled,
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.repeated.id).toBe(result.first.id);
			expect(result.a[0]?.id).toBe(result.b[0]?.id);
			expect(result.unreachable[0]).toMatchObject({
				status: 'failed',
				recipientChatId: null,
				retryable: false,
				safeError: { code: 'MissingTelegramIdentity' },
			});
			expect(result.conflicting).toMatchObject({
				_tag: 'Failure',
				failure: { reason: 'Conflict' },
			});
			expect(result).toMatchObject({
				attached: true,
				attachedTwice: false,
				cancelled: true,
				context: { status: 'cancelled' },
				materializeCancelled: {
					_tag: 'Failure',
					failure: { reason: 'Conflict' },
				},
				claimCancelled: undefined,
			});
		});

		it('fences claims, due retries, stale finalizers, unknown reconciliation, and recovery', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`claim-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 1_000_001,
				);
				const repository = yield* NotificationRepository;
				const event = yield* create(repository, owner.user.id, 'claim');
				yield* repository.materializeRecipients(
					event.id,
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
					],
					1_000,
				);
				const claims = yield* Effect.all(
					[
						repository.claimNext(event.id, 2_000, 100),
						repository.claimNext(event.id, 2_000, 100),
					],
					{ concurrency: 'unbounded' },
				);
				const first = claims.find((claim) => claim !== undefined)!;
				expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
				expect(first.delivery).toMatchObject({
					attemptGeneration: 1,
					attemptCount: 1,
				});
				expect(
					yield* repository.finalizeFailed(
						{ ...first.token, generation: 0 },
						{ message: 'stale' },
						true,
						3_000,
						2_100,
					),
				).toBe(false);
				expect(
					yield* repository.finalizeFailed(
						first.token,
						{ code: 'rate-limit', message: 'later' },
						true,
						3_000,
						2_100,
					),
				).toBe(true);
				expect(
					yield* repository.claimNext(event.id, 2_999, 100),
				).toBeUndefined();
				const second = yield* repository.claimNext(event.id, 3_000, 100);
				if (second === undefined) throw new Error('expected due retry');
				expect(second.delivery).toMatchObject({
					attemptGeneration: 2,
					attemptCount: 2,
				});
				expect(
					yield* repository.finalizeUnknown(
						second.token,
						{ message: 'ambiguous' },
						3_010,
					),
				).toBe(true);
				expect(
					yield* repository.reconcileUnknownAsSent(
						first.token,
						botId,
						10,
						3_020,
					),
				).toBe(false);
				expect(
					yield* repository.reconcileUnknownAsSent(
						second.token,
						botId,
						10,
						3_020,
					),
				).toBe(true);

				const recoveryEvent = yield* create(
					repository,
					owner.user.id,
					'recovery',
				);
				yield* repository.materializeRecipients(
					recoveryEvent.id,
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.caregiver,
							channel: 'telegram',
						},
					],
					4_000,
				);
				yield* repository.claimNext(recoveryEvent.id, 4_000, 10);
				expect(
					yield* repository.recoverExpired(recoveryEvent.id, 4_011),
				).toBeGreaterThanOrEqual(1);
				expect(
					yield* repository.claimNext(recoveryEvent.id, 5_000, 10),
				).toBeUndefined();
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('keeps mixed retryable deliveries open and completes only terminal events', async () => {
			const program = Effect.gen(function* () {
				const a = yield* register(
					`mixed-a-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 2_000_001,
				);
				const b = yield* register(
					`mixed-b-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 3_000_001,
				);
				const repository = yield* NotificationRepository;
				const event = yield* create(repository, a.user.id, 'mixed');
				yield* repository.materializeRecipients(
					event.id,
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: a.user.id,
							recipientChatId: a.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: b.user.id,
							recipientChatId: b.profile.privateChatId,
							recipientRole: RecipientRole.subscriber,
							channel: 'telegram',
						},
					],
					1_000,
				);
				const first = yield* repository.claimNext(event.id, 2_000, 100);
				if (first === undefined) throw new Error('missing first');
				yield* repository.finalizeSent(first.token, botId, 100, 2_001);
				const second = yield* repository.claimNext(event.id, 2_000, 100);
				if (second === undefined) throw new Error('missing second');
				yield* repository.finalizeFailed(
					second.token,
					{ message: 'retry' },
					true,
					5_000,
					2_001,
				);
				const open = yield* repository.summarizeAndComplete(event.id, 2_002);
				expect(open).toMatchObject({
					retryableFailed: 1,
					completed: false,
					earliestRetryAt: 5_000,
				});
				const retry = yield* repository.claimNext(event.id, 5_000, 100);
				if (retry === undefined) throw new Error('missing retry');
				yield* repository.finalizeFailed(
					retry.token,
					{ message: 'permanent' },
					false,
					null,
					5_001,
				);
				const done = yield* repository.summarizeAndComplete(event.id, 5_002);
				expect(done).toMatchObject({
					pending: 0,
					sending: 0,
					retryableFailed: 0,
					terminal: 2,
					completed: true,
				});
				return yield* repository.getDispatchContext(event.id);
			});
			const event = await Effect.runPromise(Effect.provide(program, layer));
			expect(event?.status).toBe('completed');
		});

		it('enforces role, safe integer, state-shape, and sent-message uniqueness constraints', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`constraints-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 4_000_001,
				);
				const repository = yield* NotificationRepository;
				const event = yield* create(repository, owner.user.id, 'constraints');
				const sql = yield* PgClient.PgClient;
				const invalidRole = yield* Effect.result(
					sql`INSERT INTO carneloot.notification_deliveries (id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${event.id}::uuid,${owner.user.id}::uuid,1,'Owner','telegram','pending',now(),now())`,
				);
				const invalidShape = yield* Effect.result(
					sql`INSERT INTO carneloot.notification_deliveries (id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,sending_started_at,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${event.id}::uuid,${owner.user.id}::uuid,1,'owner','telegram','pending',now(),now(),now())`,
				);
				const unsafeChat = yield* Effect.result(
					sql`INSERT INTO carneloot.notification_deliveries (id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${event.id}::uuid,${owner.user.id}::uuid,9007199254740992,'owner','telegram','pending',now(),now())`,
				);
				const secondEvent = yield* create(repository, owner.user.id, 'message');
				const [first] = yield* repository.materializeRecipients(
					event.id,
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
					],
					1_000,
				);
				const [second] = yield* repository.materializeRecipients(
					secondEvent.id,
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
					],
					1_000,
				);
				const a = yield* repository.claimNext(event.id, 2_000, 100);
				const b = yield* repository.claimNext(secondEvent.id, 2_000, 100);
				if (
					a === undefined ||
					b === undefined ||
					first === undefined ||
					second === undefined
				)
					throw new Error('missing claims');
				yield* repository.finalizeSent(a.token, botId, 999, 2_001);
				const duplicateMessage = yield* Effect.result(
					repository.finalizeSent(b.token, botId, 999, 2_001),
				);
				return { invalidRole, invalidShape, unsafeChat, duplicateMessage };
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(
				[
					result.invalidRole,
					result.invalidShape,
					result.unsafeChat,
					result.duplicateMessage,
				].every((exit) => exit._tag === 'Failure'),
			).toBe(true);
		});
	});
