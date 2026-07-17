import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import { ReminderDelay } from '../domain/pet-food/PetFood.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { ReminderScheduler } from '../ports/ReminderScheduler.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';

export const set = (access: PetFoodAccess, delayInput: unknown) =>
	Effect.gen(function* () {
		const delay = yield* Schema.decodeUnknownEffect(ReminderDelay)(
			delayInput,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid reminder delay',
						cause,
					}),
			),
		);
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
		const scheduler = yield* ReminderScheduler;
		const result = yield* sql.withTransaction(
			Effect.gen(function* () {
				const authorized = yield* authorize(access);
				if (authorized.role !== 'owner')
					return yield* Effect.fail(
						new PetAccessDenied({
							message: 'Only pet owner may configure food settings',
						}),
					);
				const now = yield* DateTime.now;
				const settings = yield* repository.setReminderDelay(
					access.petId,
					delay,
					now,
				);
				const latest = yield* repository.latestEntry(access.petId);
				if (latest !== undefined)
					yield* scheduler.replaceForLatest({
						botId: access.botId,
						ownerUserId: authorized.ownerId,
						petId: access.petId,
						foodEntryId: latest.id,
						runAt: DateTime.addDuration(latest.fedAt, delay),
					});
				return { settings, reminderScheduled: latest !== undefined };
			}),
		);
		yield* Effect.logInfo('carneloot.pet.reminder_delay_configured').pipe(
			Effect.annotateLogs({
				actorId: access.actorId,
				petId: access.petId,
				delayMs: Duration.toMillis(delay),
				reminderScheduled: result.reminderScheduled,
			}),
		);
		return result.settings;
	});

export const remove = (access: PetFoodAccess) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
		const scheduler = yield* ReminderScheduler;
		const settings = yield* sql.withTransaction(
			Effect.gen(function* () {
				const authorized = yield* authorize(access);
				if (authorized.role !== 'owner')
					return yield* Effect.fail(
						new PetAccessDenied({
							message: 'Only pet owner may configure food settings',
						}),
					);
				const now = yield* DateTime.now;
				const settings = yield* repository.clearReminderDelay(
					access.petId,
					now,
				);
				yield* scheduler.cancelForPet({
					botId: access.botId,
					petId: access.petId,
				});
				return settings;
			}),
		);
		yield* Effect.logInfo('carneloot.pet.reminder_delay_removed').pipe(
			Effect.annotateLogs({
				actorId: access.actorId,
				petId: access.petId,
			}),
		);
		return settings;
	});
