import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { Telegram } from 'tfx/Telegram';
import { RateLimitError, TelegramError } from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import * as SendExternalNotification from '../../src/application/SendExternalNotification.js';
import { TelegramChatId, UserId } from '../../src/domain/Ids.js';
import { InitialNotificationPersistenceUnavailable } from '../../src/domain/notifications/ExternalNotification.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { ApiKeyRepository } from '../../src/ports/ApiKeyRepository.js';
import {
	NotificationRecipientsError,
	NotificationRecipients,
} from '../../src/ports/NotificationRecipients.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../../src/ports/NotificationRepository.js';
import { NotificationTemplateRepository } from '../../src/ports/NotificationTemplateRepository.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';

const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const chatId = Schema.decodeUnknownSync(TelegramChatId)(42);
const eventId = Schema.decodeUnknownSync(EventId)(
	'00000000-0000-4000-8000-000000000010',
);
const input = {
	apiKey: 'a'.repeat(32),
	keyword: 'notice',
	variables: { name: 'Luna' },
};

type Scenario = {
	readonly recipients?: number;
	readonly summary?: {
		sent: number;
		failed: number;
		unknown: number;
		pending?: number;
		sending?: number;
	};
	readonly createError?: boolean;
	readonly resolutionError?: boolean;
	readonly send?: 'success' | 'rate-limit' | 'delayed-success';
	readonly finalizeSent?: boolean;
};

const run = (scenario: Scenario = {}) => {
	const calls = { sends: 0, active: 0, peak: 0, finalizes: 0 };
	const count = scenario.recipients ?? 1;
	const deliveries = Array.from({ length: count }, (_, index) => ({
		id: Schema.decodeUnknownSync(DeliveryId)(
			`00000000-0000-4000-8000-${(index + 20).toString().padStart(12, '0')}`,
		),
		recipientChatId: chatId,
		status: 'pending' as const,
	}));
	let next = 0;
	const repository = {
		createExternalEvent: () =>
			scenario.createError
				? Effect.fail(
						new NotificationRepositoryError({
							reason: 'PersistenceFailure',
							message: 'database secret',
						}),
					)
				: Effect.succeed({ event: { id: eventId }, deliveries }),
		claimNext: () => {
			const delivery = deliveries[next++];
			return Effect.succeed(
				delivery === undefined
					? undefined
					: { token: { id: delivery.id, generation: 1 }, delivery },
			);
		},
		finalizeSent: () => {
			calls.finalizes++;
			return Effect.succeed(scenario.finalizeSent ?? true);
		},
		finalizeFailed: () => Effect.succeed(true),
		finalizeUnknown: () => Effect.succeed(true),
		finalizeUnattempted: () => Effect.succeed(0),
		summarizeAndComplete: () =>
			scenario.summary === undefined
				? Effect.fail(
						new NotificationRepositoryError({
							reason: 'PersistenceFailure',
							message: 'summary unavailable',
						}),
					)
				: Effect.succeed({
						pending: 0,
						sending: 0,
						failures: [],
						completed: true,
						...scenario.summary,
					}),
	};
	const telegram = {
		sendMessage: () =>
			Effect.gen(function* () {
				calls.sends++;
				calls.active++;
				calls.peak = Math.max(calls.peak, calls.active);
				if (scenario.send === 'delayed-success')
					yield* Effect.sleep('10 millis');
				calls.active--;
				if (scenario.send === 'rate-limit')
					return yield* Effect.fail(
						new TelegramError({
							module: 'Telegram',
							method: 'sendMessage',
							reason: new RateLimitError({
								errorCode: 429,
								description: 'later',
								retryAfterSeconds: 1,
							}),
						}),
					);
				return { message_id: 99 };
			}),
	};
	const layer = Layer.mergeAll(
		DeterministicCrypto.layer(),
		Layer.succeed(ApiKeyRepository, {
			findUserIdByHash: () => Effect.succeed(ownerId),
		} as never),
		Layer.succeed(NotificationTemplateRepository, {
			findByOwnerAndKeyword: () =>
				Effect.succeed({
					template: {
						id: '00000000-0000-4000-8000-000000000011',
						ownerUserId: ownerId,
						keyword: 'notice',
						message: 'Hi {{name}}',
						createdAt: DateTime.makeUnsafe(0),
						updatedAt: DateTime.makeUnsafe(0),
					},
					subscriberUserIds: [],
				}),
		} as never),
		Layer.succeed(NotificationRecipients, {
			resolveUser: () =>
				scenario.resolutionError
					? Effect.fail(
							new NotificationRecipientsError({
								message: 'recipient database secret',
							}),
						)
					: Effect.succeed({
							_tag: 'Reachable',
							recipientUserId: ownerId,
							recipientChatId: chatId,
							recipientRole: 'owner',
							channel: 'telegram',
						}),
		} as never),
		Layer.succeed(NotificationRepository, repository as never),
		Layer.succeed(Telegram, telegram as never),
	);
	return {
		calls,
		result: Effect.runPromise(
			SendExternalNotification.execute(input).pipe(
				Effect.provide(layer),
			) as never,
		),
	};
};

describe('SendExternalNotification', () => {
	it.each([
		['200', { sent: 1, failed: 0, unknown: 0 }, 200],
		['207', { sent: 1, failed: 1, unknown: 0 }, 207],
		['502', { sent: 0, failed: 1, unknown: 0 }, 502],
		['202', { sent: 0, failed: 0, unknown: 1 }, 202],
	] as const)(
		'returns %s outcome from persisted summary',
		async (_name, summary, httpStatus) => {
			await expect(run({ summary }).result).resolves.toMatchObject({
				httpStatus,
				counts: summary,
			});
		},
	);

	it('maps initial database failure to public 503 error before sends', async () => {
		const execution = run({ createError: true });
		await expect(execution.result).rejects.toBeInstanceOf(
			InitialNotificationPersistenceUnavailable,
		);
		expect(execution.calls.sends).toBe(0);
	});

	it('maps recipient-resolution persistence failure to public error without leaking cause', async () => {
		const execution = run({ resolutionError: true });
		await expect(execution.result).rejects.toMatchObject({
			_tag: 'InitialNotificationPersistenceUnavailable',
			message: 'Initial notification persistence unavailable',
		});
		expect(execution.calls.sends).toBe(0);
	});

	it('returns indeterminate after send when final persistence is uncertain', async () => {
		const execution = run({ finalizeSent: false });
		await expect(execution.result).resolves.toMatchObject({
			httpStatus: 202,
			counts: { unknown: 1 },
		});
		expect(execution.calls.finalizes).toBe(1);
	});

	it('reports rate limits as failed direct delivery', async () => {
		await expect(
			run({ send: 'rate-limit', summary: { sent: 0, failed: 1, unknown: 0 } })
				.result,
		).resolves.toMatchObject({ httpStatus: 502 });
	});

	it('bounds direct dispatch concurrency to four', async () => {
		const execution = run({
			recipients: 8,
			send: 'delayed-success',
			summary: { sent: 8, failed: 0, unknown: 0 },
		});
		await execution.result;
		expect(execution.calls).toMatchObject({ sends: 8, peak: 4 });
	});
});
