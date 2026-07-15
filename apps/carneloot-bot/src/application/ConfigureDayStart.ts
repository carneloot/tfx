import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import { IanaTimeZone, LocalTime } from '../domain/pet-food/FoodDateTime.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';

export const execute = (
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
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* authorize(access);
				const now = yield* Clock.currentTimeMillis;
				return yield* repository.setDayStart(
					access.petId,
					dayStart,
					timeZone,
					now,
				);
			}),
		);
	});
