import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import { IanaTimeZone, LocalTime } from '../domain/pet-food/FoodDateTime.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';

export const execute = Effect.fn('ConfigureDayStart.execute')
	((
	access: PetFoodAccess,
	dayStartInput: unknown,
	timeZoneInput: unknown,
) =>
	Effect.gen(function* () {
		const dayStart = yield* Schema.decodeUnknownEffect(LocalTime)(
			dayStartInput,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid day start',
						cause,
					}),
			),
		);
		const timeZone = yield* Schema.decodeUnknownEffect(IanaTimeZone)(
			timeZoneInput,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({ message: 'Invalid time zone', cause }),
			),
		);
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
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
				return yield* repository.setDayStart(
					access.petId,
					dayStart,
					timeZone,
					now,
				);
			}),
		);
		yield* Effect.logInfo('carneloot.pet.day_start_configured').pipe(
			Effect.annotateLogs({
				actorId: access.actorId,
				petId: access.petId,
				dayStart,
				timeZone,
			}),
		);
		return settings;
	}));
