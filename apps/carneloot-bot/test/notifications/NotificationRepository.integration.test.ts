import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';

import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import * as RecipientRole from '../../src/domain/notifications/RecipientRole.js';
import { Uuid } from '../../src/domain/Uuid.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
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
	now = DateTime.makeUnsafe(1_000),
) =>
	repository.createEvent({
		id: eventId(),
		botId,
		kind: 'feeding-reminder',
		ownerUserId,
		petId: null,
		foodEntryId: null,
		scheduledFor: now,
		foodTimestampExplicit: false,
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
					kind: 'food-added',
					ownerUserId: owner.user.id,
					petId: null,
					foodEntryId: null,
					scheduledFor: DateTime.makeUnsafe(1_000),
					foodTimestampExplicit: false,
					dedupeKey: `dedupe-${crypto.randomUUID()}`,
					now: DateTime.makeUnsafe(1_000),
				} as const;
				const first = yield* repository.createEvent(input);
				const repeated = yield* repository.createEvent({
					...input,
					id: eventId(),
				});
				const timestampConflicting = yield* Effect.result(
					repository.createEvent({
						...input,
						id: eventId(),
						foodTimestampExplicit: true,
					}),
				);
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
					DateTime.makeUnsafe(1_000),
				);
				const b = yield* repository.materializeRecipients(
					first.id,
					[{ ...recipient, id: deliveryId() }],
					DateTime.makeUnsafe(1_001),
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
					DateTime.makeUnsafe(1_001),
				);
				const attached = yield* repository.attachJob(
					first.id,
					crypto.randomUUID(),
					DateTime.makeUnsafe(1_002),
				);
				const attachedTwice = yield* repository.attachJob(
					first.id,
					crypto.randomUUID(),
					DateTime.makeUnsafe(1_003),
				);
				const cancelled = yield* repository.cancelEvent(
					first.id,
					DateTime.makeUnsafe(1_004),
				);
				const context = yield* repository.getDispatchContext(first.id);
				const materializeCancelled = yield* Effect.result(
					repository.materializeRecipients(
						first.id,
						[{ ...recipient, id: deliveryId(), channel: 'telegram-backup' }],
						DateTime.makeUnsafe(1_005),
					),
				);
				const claimCancelled = yield* repository.claimNext(
					first.id,
					DateTime.makeUnsafe(1_005),
					Duration.millis(100),
				);
				const cancelledSummary = yield* repository.summarizeAndComplete(
					first.id,
					DateTime.makeUnsafe(1_006),
				);
				return {
					first,
					repeated,
					timestampConflicting,
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
					cancelledSummary,
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.repeated.id).toBe(result.first.id);
			expect(result.first).toMatchObject({
				recipientsMaterializedAt: null,
				foodTimestampExplicit: false,
			});
			expect(result.a[0]?.id).toBe(result.b[0]?.id);
			expect(result.unreachable[0]).toMatchObject({
				status: 'failed',
				recipientChatId: null,
				retryable: false,
				safeError: { code: 'MissingTelegramIdentity' },
			});
			expect(result.timestampConflicting).toMatchObject({
				_tag: 'Failure',
				failure: { reason: 'Conflict' },
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
				cancelledSummary: { completed: false },
			});
		});

		it('freezes one complete recipient set across concurrent materializers', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`freeze-owner-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 5_000_001,
				);
				const caregiverA = yield* register(
					`freeze-a-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 6_000_001,
				);
				const caregiverB = yield* register(
					`freeze-b-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 7_000_001,
				);
				const repository = yield* NotificationRepository;
				const sql = yield* PgClient.PgClient;
				const event = yield* create(repository, owner.user.id, 'freeze');
				const now = DateTime.makeUnsafe(2_000);
				const sets = [
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: caregiverA.user.id,
							recipientChatId: caregiverA.profile.privateChatId,
							recipientRole: RecipientRole.caregiver,
							channel: 'telegram',
						},
					],
					[
						{
							_tag: 'Reachable' as const,
							id: deliveryId(),
							recipientUserId: caregiverB.user.id,
							recipientChatId: caregiverB.profile.privateChatId,
							recipientRole: RecipientRole.caregiver,
							channel: 'telegram',
						},
					],
				] as const;
				const materializeOnce = (recipients: (typeof sets)[number]) =>
					sql.withTransaction(
						Effect.gen(function* () {
							const locked = yield* repository.lockForMaterialization(event.id);
							if (
								locked === undefined ||
								locked.recipientsMaterializedAt !== null
							)
								return [];
							const deliveries = yield* repository.materializeRecipients(
								event.id,
								recipients,
								now,
							);
							expect(
								yield* repository.markRecipientsMaterialized(event.id, now),
							).toBe(true);
							return deliveries;
						}),
					);
				const results = yield* Effect.all(sets.map(materializeOnce), {
					concurrency: 'unbounded',
				});
				const retry = yield* materializeOnce([
					{ ...sets[1][0], id: deliveryId() },
				]);
				const rows = yield* sql<{
					recipient_user_id: string;
				}>`SELECT recipient_user_id FROM carneloot.notification_deliveries WHERE event_id=${event.id}::uuid ORDER BY recipient_user_id`;
				return {
					results,
					retry,
					recipients: rows.map((row) => row.recipient_user_id),
					context: yield* repository.getDispatchContext(event.id),
					setA: sets[0].map((recipient) => recipient.recipientUserId).sort(),
					setB: sets[1].map((recipient) => recipient.recipientUserId).sort(),
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(
				result.results.filter((deliveries) => deliveries.length > 0),
			).toHaveLength(1);
			expect(result.retry).toEqual([]);
			expect([result.setA, result.setB]).toContainEqual(result.recipients);
			expect(result.context?.recipientsMaterializedAt).toEqual(
				DateTime.makeUnsafe(2_000),
			);
		});

		it('rolls back deliveries and materialization marker on transaction failure', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`rollback-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 8_000_001,
				);
				const repository = yield* NotificationRepository;
				const sql = yield* PgClient.PgClient;
				const event = yield* create(repository, owner.user.id, 'rollback');
				const now = DateTime.makeUnsafe(2_000);
				const attempted = yield* Effect.result(
					sql.withTransaction(
						Effect.gen(function* () {
							const locked = yield* repository.lockForMaterialization(event.id);
							expect(locked?.recipientsMaterializedAt).toBeNull();
							yield* repository.materializeRecipients(
								event.id,
								[
									{
										_tag: 'Reachable',
										id: deliveryId(),
										recipientUserId: owner.user.id,
										recipientChatId: owner.profile.privateChatId,
										recipientRole: RecipientRole.owner,
										channel: 'telegram',
									},
								],
								now,
							);
							expect(
								yield* repository.markRecipientsMaterialized(event.id, now),
							).toBe(true);
							yield* sql`SELECT 1 / 0`;
						}),
					),
				);
				const counts = yield* sql<{
					count: number;
				}>`SELECT count(*)::int count FROM carneloot.notification_deliveries WHERE event_id=${event.id}::uuid`;
				return {
					attempted,
					count: counts[0]?.count,
					context: yield* repository.getDispatchContext(event.id),
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.attempted._tag).toBe('Failure');
			expect(result.count).toBe(0);
			expect(result.context?.recipientsMaterializedAt).toBeNull();
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
					DateTime.makeUnsafe(1_000),
				);
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						owner.profile.privateChatId,
						10,
					),
				).toBeUndefined();
				const claims = yield* Effect.all(
					[
						repository.claimNext(
							event.id,
							DateTime.makeUnsafe(2_000),
							Duration.millis(100),
						),
						repository.claimNext(
							event.id,
							DateTime.makeUnsafe(2_000),
							Duration.millis(100),
						),
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
						DateTime.makeUnsafe(3_000),
						DateTime.makeUnsafe(2_100),
					),
				).toBe(false);
				expect(
					yield* repository.finalizeFailed(
						first.token,
						{ code: 'rate-limit', message: 'later' },
						true,
						DateTime.makeUnsafe(3_000),
						DateTime.makeUnsafe(2_100),
					),
				).toBe(true);
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						owner.profile.privateChatId,
						10,
					),
				).toBeUndefined();
				expect(
					yield* repository.claimNext(
						event.id,
						DateTime.makeUnsafe(2_999),
						Duration.millis(100),
					),
				).toBeUndefined();
				const second = yield* repository.claimNext(
					event.id,
					DateTime.makeUnsafe(3_000),
					Duration.millis(100),
				);
				if (second === undefined) throw new Error('expected due retry');
				expect(second.delivery).toMatchObject({
					attemptGeneration: 2,
					attemptCount: 2,
				});
				expect(
					yield* repository.finalizeUnknown(
						second.token,
						{ message: 'ambiguous' },
						DateTime.makeUnsafe(3_010),
					),
				).toBe(true);
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						owner.profile.privateChatId,
						10,
					),
				).toBeUndefined();
				expect(
					yield* repository.reconcileUnknownAsSent(
						first.token,
						botId,
						10,
						DateTime.makeUnsafe(3_020),
					),
				).toBe(false);
				expect(
					yield* repository.reconcileUnknownAsSent(
						second.token,
						botId,
						10,
						DateTime.makeUnsafe(3_020),
					),
				).toBe(true);
				const reply = yield* repository.findSentByTelegramMessage(
					botId,
					owner.profile.privateChatId,
					10,
				);
				expect(reply).toMatchObject({
					delivery: { id: second.delivery.id, status: 'sent' },
					event: { id: event.id },
				});
				expect(
					yield* repository.findSentByTelegramMessage(
						Schema.decodeUnknownSync(BotId)('different-bot'),
						owner.profile.privateChatId,
						10,
					),
				).toBeUndefined();
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						Schema.decodeUnknownSync(TelegramChatId)(
							owner.profile.privateChatId + 1,
						),
						10,
					),
				).toBeUndefined();
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						owner.profile.privateChatId,
						11,
					),
				).toBeUndefined();
				expect(
					yield* repository.findSentByTelegramMessage(
						botId,
						owner.profile.privateChatId,
						Number.MAX_SAFE_INTEGER + 1,
					),
				).toBeUndefined();
				const findSent = repository.findSentByTelegramMessage;
				// @ts-expect-error Exercise runtime validation at typed boundary.
				const malformedChat = findSent(botId, 0, 10);
				expect(yield* malformedChat).toBeUndefined();

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
					DateTime.makeUnsafe(4_000),
				);
				yield* repository.claimNext(
					recoveryEvent.id,
					DateTime.makeUnsafe(4_000),
					Duration.millis(10),
				);
				expect(
					yield* repository.recoverAllExpired(DateTime.makeUnsafe(4_011)),
				).toBeGreaterThanOrEqual(1);
				expect(
					yield* repository.claimNext(
						recoveryEvent.id,
						DateTime.makeUnsafe(5_000),
						Duration.millis(10),
					),
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
					DateTime.makeUnsafe(1_000),
				);
				const first = yield* repository.claimNext(
					event.id,
					DateTime.makeUnsafe(2_000),
					Duration.millis(100),
				);
				if (first === undefined) throw new Error('missing first');
				yield* repository.finalizeSent(
					first.token,
					botId,
					100,
					DateTime.makeUnsafe(2_001),
				);
				const second = yield* repository.claimNext(
					event.id,
					DateTime.makeUnsafe(2_000),
					Duration.millis(100),
				);
				if (second === undefined) throw new Error('missing second');
				yield* repository.finalizeFailed(
					second.token,
					{ message: 'retry' },
					true,
					DateTime.makeUnsafe(5_000),
					DateTime.makeUnsafe(2_001),
				);
				const open = yield* repository.summarizeAndComplete(
					event.id,
					DateTime.makeUnsafe(2_002),
				);
				expect(open).toMatchObject({
					retryableFailed: 1,
					completed: false,
					earliestRetryAt: DateTime.makeUnsafe(5_000),
				});
				const retry = yield* repository.claimNext(
					event.id,
					DateTime.makeUnsafe(5_000),
					Duration.millis(100),
				);
				if (retry === undefined) throw new Error('missing retry');
				yield* repository.finalizeFailed(
					retry.token,
					{ message: 'permanent' },
					false,
					null,
					DateTime.makeUnsafe(5_001),
				);
				const done = yield* repository.summarizeAndComplete(
					event.id,
					DateTime.makeUnsafe(5_002),
				);
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
					DateTime.makeUnsafe(1_000),
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
					DateTime.makeUnsafe(1_000),
				);
				const a = yield* repository.claimNext(
					event.id,
					DateTime.makeUnsafe(2_000),
					Duration.millis(100),
				);
				const b = yield* repository.claimNext(
					secondEvent.id,
					DateTime.makeUnsafe(2_000),
					Duration.millis(100),
				);
				if (
					a === undefined ||
					b === undefined ||
					first === undefined ||
					second === undefined
				)
					throw new Error('missing claims');
				yield* repository.finalizeSent(
					a.token,
					botId,
					999,
					DateTime.makeUnsafe(2_001),
				);
				const duplicateMessage = yield* Effect.result(
					repository.finalizeSent(
						b.token,
						botId,
						999,
						DateTime.makeUnsafe(2_001),
					),
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

		it('atomically persists frozen external payloads and recipient deliveries', async () => {
			const program = Effect.gen(function* () {
				const owner = yield* register(
					`owner-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 1,
				);
				const subscriber = yield* register(
					`subscriber-${crypto.randomUUID()}`,
					Math.floor(Math.random() * 1_000_000) + 1_000_001,
				);
				const sql = yield* PgClient.PgClient;
				const repository = yield* NotificationRepository;
				const templateId = crypto.randomUUID();
				yield* sql`INSERT INTO carneloot.notification_templates (id,owner_user_id,keyword,message,created_at,updated_at) VALUES (${templateId}::uuid,${owner.user.id}::uuid,'external-test','before',now(),now())`;
				const now = DateTime.makeUnsafe(1_000);
				const created = yield* repository.createExternalEvent(
					{
						id: eventId(),
						botId,
						kind: 'external-notification',
						ownerUserId: owner.user.id,
						petId: null,
						foodEntryId: null,
						scheduledFor: null,
						foodTimestampExplicit: false,
						dedupeKey: `external-${crypto.randomUUID()}`,
						now,
					},
					{
						templateId: Schema.decodeUnknownSync(Uuid)(templateId),
						renderedMessage: 'frozen message',
					},
					[
						{
							_tag: 'Reachable',
							id: deliveryId(),
							recipientUserId: owner.user.id,
							recipientChatId: owner.profile.privateChatId,
							recipientRole: RecipientRole.owner,
							channel: 'telegram',
						},
						{
							_tag: 'Reachable',
							id: deliveryId(),
							recipientUserId: subscriber.user.id,
							recipientChatId: subscriber.profile.privateChatId,
							recipientRole: RecipientRole.subscriber,
							channel: 'telegram',
						},
					],
				);
				yield* sql`UPDATE carneloot.notification_templates SET message='after' WHERE id=${templateId}::uuid`;
				const payload = yield* sql<{
					rendered_message: string;
				}>`SELECT rendered_message FROM carneloot.notification_event_payloads WHERE event_id=${created.event.id}::uuid`;
				const failedEventId = eventId();
				const failed = yield* Effect.result(
					repository.createExternalEvent(
						{
							id: failedEventId,
							botId,
							kind: 'external-notification',
							ownerUserId: owner.user.id,
							petId: null,
							foodEntryId: null,
							scheduledFor: null,
							foodTimestampExplicit: false,
							dedupeKey: `external-fail-${crypto.randomUUID()}`,
							now,
						},
						{ templateId: null, renderedMessage: 'will roll back' },
						[
							{
								_tag: 'Reachable',
								id: deliveryId(),
								recipientUserId: Schema.decodeUnknownSync(UserId)(
									'00000000-0000-4000-8000-000000000001',
								),
								recipientChatId: owner.profile.privateChatId,
								recipientRole: RecipientRole.subscriber,
								channel: 'telegram',
							},
						],
					),
				);
				const rolledBack =
					yield* sql`SELECT id FROM carneloot.notification_events WHERE id=${failedEventId}::uuid`;
				return { created, payload, failed, rolledBack };
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.created.deliveries).toHaveLength(2);
			expect(
				result.created.deliveries.map((delivery) => delivery.status),
			).toStrictEqual(['pending', 'pending']);
			expect(result.payload).toStrictEqual([
				{ rendered_message: 'frozen message' },
			]);
			expect(result.failed._tag).toBe('Failure');
			expect(result.rolledBack).toStrictEqual([]);
		});
	});
