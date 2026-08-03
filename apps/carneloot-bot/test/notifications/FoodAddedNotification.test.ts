import { Duration, Effect, Layer, Schema } from 'effect';
import { JobRuntime, type JobRuntimeService } from 'tfx/JobRuntime';
import { describe, expect, it } from 'vitest';

import * as DispatchNotificationDelivery from '../../src/application/DispatchNotificationDelivery.js';
import { BotId, PetId, TelegramChatId, UserId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import * as RecipientRole from '../../src/domain/notifications/RecipientRole.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import * as FoodAddedNotificationJob from '../../src/jobs/FoodAddedNotificationJob.js';
import { FoodNotificationScheduler } from '../../src/ports/FoodNotificationScheduler.js';
import { NotificationRecipients } from '../../src/ports/NotificationRecipients.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../../src/ports/NotificationRepository.js';
import * as FoodNotificationSchedulerLive from '../../src/postgres/FoodNotificationSchedulerLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';

describe('FoodAddedNotificationJob declaration', () => {
	it('renders actor, pet, amount, and optional localized timestamp', () => {
		expect(
			DispatchNotificationDelivery.foodAddedText('Ana Silva', 'Rex', 50_000),
		).toBe('Ana Silva colocou 50 g de ração para Rex.');
		expect(
			DispatchNotificationDelivery.foodAddedText('Ana Silva', 'Rex', 50_000, {
				date: new Date('2026-07-16T11:30:00Z'),
				timeZone: 'America/Sao_Paulo',
			}),
		).toBe('Ana Silva colocou 50 g de ração para Rex em 16/07/2026 08:30.');
	});

	it('owns versioned payload and bounded retry policy', () => {
		const payload = {
			eventId: Schema.decodeUnknownSync(EventId)(
				'00000000-0000-4000-8000-000000000001',
			),
			botId: Schema.decodeUnknownSync(BotId)('carneloot'),
			petId: Schema.decodeUnknownSync(PetId)(
				'00000000-0000-4000-8000-000000000002',
			),
			foodEntryId: Schema.decodeUnknownSync(FoodEntryId)(
				'00000000-0000-4000-8000-000000000003',
			),
		};
		expect(
			Schema.decodeUnknownSync(FoodAddedNotificationJob.PayloadV1)(payload),
		).toEqual(payload);
		expect(FoodAddedNotificationJob.declaration).toMatchObject({
			name: 'food-added-notification',
			maxAttempts: 8,
		});
		expect(FoodAddedNotificationJob.declaration.payload.latest.version).toBe(1);
		const retryAfter = Duration.seconds(7);
		const retry = FoodAddedNotificationJob.declaration.retry(
			new FoodAddedNotificationJob.FoodAddedNotificationRetryError({
				message: 'transient',
				retryAfter,
			}),
		);
		expect(retry?._tag).toBe('Retry');
		if (retry?._tag === 'Retry')
			expect(Duration.equals(retry.retryAfter!, retryAfter)).toBe(true);
		expect(
			FoodAddedNotificationJob.declaration.retry(
				new FoodAddedNotificationJob.FoodAddedNotificationPermanentError({
					message: 'deleted context',
				}),
			),
		).toEqual({ _tag: 'Permanent' });
		expect(
			Duration.equals(
				FoodAddedNotificationJob.declaration.schedule(8),
				Duration.minutes(30),
			),
		).toBe(true);
	});

	it('classifies repository conflicts and invariants as non-retryable', async () => {
		const botId = Schema.decodeUnknownSync(BotId)('carneloot');
		const ownerUserId = Schema.decodeUnknownSync(UserId)(
			'00000000-0000-4000-8000-000000000004',
		);
		const actorUserId = Schema.decodeUnknownSync(UserId)(
			'00000000-0000-4000-8000-000000000005',
		);
		const petId = Schema.decodeUnknownSync(PetId)(
			'00000000-0000-4000-8000-000000000002',
		);
		const foodEntryId = Schema.decodeUnknownSync(FoodEntryId)(
			'00000000-0000-4000-8000-000000000003',
		);
		const jobs: JobRuntimeService = {
			schedule: () => Effect.die('unused'),
			runOne: () => Effect.die('unused'),
			problems: Effect.succeed([]),
			cancel: () => Effect.die('unused'),
			releaseFailed: () => Effect.die('unused'),
		};
		const recipients = Layer.succeed(NotificationRecipients, {
			resolveUser: () => Effect.die('unused'),
			resolveOwner: () => Effect.die('unused'),
			resolvePetRecipients: () =>
				Effect.succeed([
					{
						userId: ownerUserId,
						role: 'owner' as const,
						resolution: {
							_tag: 'Reachable' as const,
							recipientUserId: ownerUserId,
							recipientChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
							recipientRole: RecipientRole.owner,
							channel: 'telegram' as const,
						},
					},
				]),
		});
		for (const [repositoryReason, expectedReason] of [
			['Conflict', 'InvariantViolation'],
			['InvariantViolation', 'InvariantViolation'],
			['PersistenceFailure', 'PersistenceFailure'],
		] as const) {
			const repository = Layer.succeed(NotificationRepository, {
				createEvent: () =>
					Effect.fail(
						new NotificationRepositoryError({
							reason: repositoryReason,
							message: 'injected',
						}),
					),
			} as never);
			const layer = Layer.provide(
				FoodNotificationSchedulerLive.layer,
				Layer.mergeAll(
					recipients,
					repository,
					Layer.succeed(JobRuntime, jobs),
					DeterministicCrypto.layer(),
				),
			);
			const result = await Effect.runPromise(
				Effect.result(
					Effect.flatMap(FoodNotificationScheduler, (scheduler) =>
						scheduler.scheduleAdded({
							botId,
							ownerUserId,
							actorUserId,
							petId,
							foodEntryId,
							sourceUpdateId: 1,
							timestampExplicit: false,
						}),
					),
				).pipe(Effect.provide(layer)),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { reason: expectedReason },
			});
		}
	});
});
