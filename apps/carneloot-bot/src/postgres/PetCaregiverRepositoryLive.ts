import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import {
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
} from '../domain/caregivers/CaregiverError.js';
import { PetCaregiver } from '../domain/caregivers/PetCaregiver.js';
import { DomainPersistenceError } from '../domain/DomainError.js';
import type { PetId, UserId } from '../domain/Ids.js';
import {
	PetCaregiverRepository,
	type PetCaregiverRepositoryService,
} from '../ports/PetCaregiverRepository.js';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
const Row = Schema.Struct({
	pet_id: PetCaregiver.fields.petId,
	caregiver_user_id: PetCaregiver.fields.caregiverUserId,
	status: PetCaregiver.fields.status,
	created_at: Timestamp,
	updated_at: Timestamp,
});
const decode = (value: unknown) =>
	Schema.decodeUnknownEffect(Row)(value).pipe(
		Effect.map((row) => ({
			petId: row.pet_id,
			caregiverUserId: row.caregiver_user_id,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		})),
		Effect.mapError(
			(cause) =>
				new DomainPersistenceError({
					reason: 'InvariantViolation',
					message: 'Malformed caregiver row',
					cause,
				}),
		),
	);
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
const persistence = (cause: unknown): DomainPersistenceError =>
	cause instanceof DomainPersistenceError
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'Caregiver repository failed',
				cause,
			});

export const layer = Layer.effect(
	PetCaregiverRepository,
	Effect.map(PgClient.PgClient, (sql) => {
		const one = (petId: PetId, caregiverUserId: UserId, lock: boolean) =>
			sql
				.unsafe<Record<string, unknown>>(
					`SELECT * FROM carneloot.pet_caregivers WHERE pet_id=$1::uuid AND caregiver_user_id=$2::uuid${lock ? ' FOR UPDATE' : ''}`,
					[petId, caregiverUserId],
				)
				.pipe(
					Effect.flatMap((rows) =>
						rows[0] === undefined ? Effect.succeed(undefined) : decode(rows[0]),
					),
					Effect.mapError(persistence),
				);
		const listBy = (caregiverUserId: UserId, status: 'pending' | 'accepted') =>
			sql<
				Record<string, unknown>
			>`SELECT * FROM carneloot.pet_caregivers WHERE caregiver_user_id=${caregiverUserId}::uuid AND status=${status} ORDER BY pet_id`.pipe(
				Effect.flatMap((rows) => Effect.forEach(rows, decode)),
				Effect.mapError(persistence),
			);
		const service = {
			find: (petId, caregiverUserId) => one(petId, caregiverUserId, false),
			lock: (petId, caregiverUserId) => one(petId, caregiverUserId, true),
			insertPending: (petId, caregiverUserId, now) =>
				sql<
					Record<string, unknown>
				>`INSERT INTO carneloot.pet_caregivers (pet_id,caregiver_user_id,status,created_at,updated_at) VALUES (${petId}::uuid,${caregiverUserId}::uuid,'pending',${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) RETURNING *`.pipe(
					Effect.flatMap((rows) => decode(rows[0])),
					Effect.mapError((cause) =>
						constraint(cause) === 'pet_caregivers_pk'
							? new CaregiverRelationshipExists({
									message: 'Caregiver relationship already exists',
								})
							: persistence(cause),
					),
				),
			setPendingResponse: (petId, caregiverUserId, status, now) =>
				Effect.gen(function* () {
					const rows = yield* sql<
						Record<string, unknown>
					>`UPDATE carneloot.pet_caregivers SET status=${status},updated_at=${DateTime.toDateUtc(now)} WHERE pet_id=${petId}::uuid AND caregiver_user_id=${caregiverUserId}::uuid AND status='pending' RETURNING *`.pipe(
						Effect.mapError(persistence),
					);
					const row = rows[0];
					if (row === undefined)
						return yield* Effect.fail(
							new CaregiverInvitationNotPending({
								message: 'Caregiver invitation is not pending',
							}),
						);
					return yield* decode(row);
				}),
			remove: (petId, caregiverUserId) =>
				sql`DELETE FROM carneloot.pet_caregivers WHERE pet_id=${petId}::uuid AND caregiver_user_id=${caregiverUserId}::uuid RETURNING pet_id`.pipe(
					Effect.map((rows) => rows.length > 0),
					Effect.mapError(persistence),
				),
			listForPet: (petId) =>
				sql<
					Record<string, unknown>
				>`SELECT * FROM carneloot.pet_caregivers WHERE pet_id=${petId}::uuid ORDER BY caregiver_user_id`.pipe(
					Effect.flatMap((rows) => Effect.forEach(rows, decode)),
					Effect.mapError(persistence),
				),
			listPendingForUser: (caregiverUserId) =>
				listBy(caregiverUserId, 'pending'),
			listAcceptedForUser: (caregiverUserId) =>
				listBy(caregiverUserId, 'accepted'),
		} satisfies PetCaregiverRepositoryService;
		return service;
	}),
);
