import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import { ReminderDelay } from '../domain/pet-food/PetFood.js';
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
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* authorize(access);
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
						ownerUserId: access.ownerId,
						petId: access.petId,
						foodEntryId: latest.id,
						runAt: DateTime.addDuration(latest.fedAt, delay),
					});
				return settings;
			}),
		);
	});

export const remove = (access: PetFoodAccess) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
		const scheduler = yield* ReminderScheduler;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* authorize(access);
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
	});
