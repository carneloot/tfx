import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);

import {
	DomainPersistenceError,
	PetNameAlreadyExists,
	UserNotRegistered,
} from '../domain/DomainError.js';
import { PetId, UserId } from '../domain/Ids.js';
import { PetName, petNameKey } from '../domain/Pet.js';
import {
	PetRepository,
	type PetRepositoryService,
} from '../ports/PetRepository.js';

const Row = Schema.Struct({
	id: PetId,
	owner_id: UserId,
	name: PetName,
	created_at: Timestamp,
	updated_at: Timestamp,
});
const decode = (value: unknown) =>
	Effect.try({
		try: () => {
			const row = Schema.decodeUnknownSync(Row)(value);
			return {
				id: row.id,
				ownerId: row.owner_id,
				name: row.name,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			};
		},
		catch: (cause) =>
			new DomainPersistenceError({
				reason: 'InvariantViolation',
				message: 'Malformed pet row',
				cause,
			}),
	});
const constraint = (cause: unknown): unknown => {
	if (typeof cause !== 'object' || cause === null) return undefined;
	if ('constraint' in cause) return cause.constraint;
	if (
		'reason' in cause &&
		typeof cause.reason === 'object' &&
		cause.reason !== null &&
		'constraint' in cause.reason
	)
		return cause.reason.constraint;
	return undefined;
};
const persistence = (cause: unknown) =>
	cause instanceof DomainPersistenceError || cause instanceof UserNotRegistered
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'Pet repository failed',
				cause,
			});

export const layer = Layer.effect(
	PetRepository,
	Effect.map(PgClient.PgClient, (sql) => {
		const assertOwner = (ownerId: UserId) =>
			Effect.andThen(
				Schema.decodeUnknownEffect(UserId)(ownerId).pipe(
					Effect.mapError(persistence),
				),
				Effect.flatMap(
					sql`SELECT id FROM carneloot.users WHERE id=${ownerId}::uuid FOR SHARE`,
					(rows) =>
						rows.length === 0
							? Effect.fail(
									new UserNotRegistered({ message: 'Owner no longer exists' }),
								)
							: Effect.void,
				),
			);
		const service = {
			findById: (petId) =>
				sql<
					Record<string, unknown>
				>`SELECT * FROM carneloot.pets WHERE id=${petId}::uuid`.pipe(
					Effect.flatMap((rows) =>
						rows[0] === undefined ? Effect.succeed(undefined) : decode(rows[0]),
					),
					Effect.mapError((cause) =>
						cause instanceof DomainPersistenceError
							? cause
							: new DomainPersistenceError({
									reason: 'PersistenceFailure',
									message: 'Pet lookup failed',
									cause,
								}),
					),
				),
			addOwned: (ownerId, name) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* assertOwner(ownerId);
							const now = yield* DateTime.now;
							const timestamp = DateTime.toDateUtc(now);
							const rows = yield* sql<
								Record<string, unknown>
							>`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${ownerId}::uuid,${name},${petNameKey(name)},${timestamp},${timestamp}) RETURNING *`;
							return yield* decode(rows[0]);
						}),
					)
					.pipe(
						Effect.mapError((cause) =>
							constraint(cause) === 'pets_owner_name_key'
								? new PetNameAlreadyExists({
										message: 'Pet name already exists',
									})
								: persistence(cause),
						),
					),
			listOwned: (ownerId) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* assertOwner(ownerId);
							const rows = yield* sql<
								Record<string, unknown>
							>`SELECT * FROM carneloot.pets WHERE owner_id=${ownerId}::uuid ORDER BY name_key,id`;
							return yield* Effect.forEach(rows, decode);
						}),
					)
					.pipe(Effect.mapError(persistence)),
		} satisfies PetRepositoryService;
		return service;
	}),
);
