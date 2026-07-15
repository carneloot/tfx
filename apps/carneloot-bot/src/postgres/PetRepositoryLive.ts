import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import {
	DomainPersistenceError,
	PetNameAlreadyExists,
	UserNotRegistered,
} from '../domain/DomainError.js';
import { PetId, UserId } from '../domain/Ids.js';
import { PetName, petNameKey, type Pet } from '../domain/Pet.js';
import {
	PetRepository,
	type PetRepositoryService,
} from '../ports/PetRepository.js';

const Row = Schema.Struct({
	id: PetId,
	owner_id: UserId,
	name: PetName,
	created_at: Schema.Unknown,
	updated_at: Schema.Unknown,
});
const decode = (value: unknown): Effect.Effect<Pet, DomainPersistenceError> =>
	Effect.try({
		try: () => {
			const row = Schema.decodeUnknownSync(Row)(value);
			const createdAt = new Date(row.created_at as string).getTime();
			const updatedAt = new Date(row.updated_at as string).getTime();
			if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt))
				throw new Error('Invalid timestamp');
			return {
				id: row.id,
				ownerId: row.owner_id,
				name: row.name,
				createdAt,
				updatedAt,
			};
		},
		catch: (cause) =>
			new DomainPersistenceError({ message: 'Malformed pet row', cause }),
	});
const constraint = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'constraint' in cause
		? (cause as { readonly constraint?: unknown }).constraint
		: undefined;
const persistence = (
	cause: unknown,
): DomainPersistenceError | UserNotRegistered =>
	cause instanceof DomainPersistenceError || cause instanceof UserNotRegistered
		? cause
		: new DomainPersistenceError({ message: 'Pet repository failed', cause });

export const layer: Layer.Layer<
	PetRepository,
	DomainPersistenceError,
	PgClient.PgClient
> = Layer.effect(
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
		const service: PetRepositoryService = {
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
							const now = yield* Clock.currentTimeMillis;
							const timestamp = new Date(now);
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
		};
		return service;
	}),
);
