import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { BotId, PetId, TelegramChatId, UserId } from '../domain/Ids.js';
import { FoodAmountMg } from '../domain/pet-food/FoodAmount.js';
import { IanaTimeZone, LocalTime } from '../domain/pet-food/FoodDateTime.js';
import { FoodEntryId, PetFoodSettings } from '../domain/pet-food/PetFood.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import { PetName, type Pet } from '../domain/Pet.js';
import {
	PetFoodRepository,
	type PetFoodRepositoryService,
} from '../ports/PetFoodRepository.js';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
const DurationMillis = Schema.DurationFromMillis;
const safeInteger = (value: unknown, minimum = 0) => {
	const result = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(result) || result < minimum)
		throw new Error('Unsafe integer');
	return result;
};
const persistence = (message: string, cause: unknown) =>
	cause instanceof DomainPersistenceError || cause instanceof PetAccessDenied
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message,
				cause,
			});
const invariant = (message: string, cause: unknown) =>
	cause instanceof DomainPersistenceError || cause instanceof PetAccessDenied
		? cause
		: new DomainPersistenceError({
				reason: 'InvariantViolation',
				message,
				cause,
			});
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
	effect.pipe(Effect.mapError((cause) => persistence(message, cause)));

const PetRow = Schema.Struct({
	id: PetId,
	owner_id: UserId,
	name: PetName,
	created_at: Timestamp,
	updated_at: Timestamp,
});
const SettingsRow = Schema.Struct({
	pet_id: PetId,
	day_start: Schema.NullOr(Schema.String),
	timezone: Schema.NullOr(Schema.String),
	reminder_delay_ms: Schema.NullOr(
		Schema.Union([Schema.String, Schema.Number]),
	),
	created_at: Timestamp,
	updated_at: Timestamp,
});
const EntryRow = Schema.Struct({
	id: FoodEntryId,
	pet_id: PetId,
	recorded_by: UserId,
	amount_mg: Schema.Union([Schema.String, Schema.Number]),
	fed_at: Timestamp,
	source_bot_id: Schema.NonEmptyString,
	source_update_id: Schema.Union([Schema.String, Schema.Number]),
	source_message_chat_id: Schema.NullOr(
		Schema.Union([Schema.String, Schema.Number]),
	),
	source_message_id: Schema.NullOr(
		Schema.Union([Schema.String, Schema.Number]),
	),
	created_at: Timestamp,
	updated_at: Timestamp,
});
const decodePet = (raw: unknown): Pet => {
	const row = Schema.decodeUnknownSync(PetRow)(raw);
	return {
		id: row.id,
		ownerId: row.owner_id,
		name: row.name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
};
const decodeSettings = (raw: unknown) => {
	const row = Schema.decodeUnknownSync(SettingsRow)(raw);
	const value = {
		petId: row.pet_id,
		dayStart:
			row.day_start === null
				? null
				: Schema.decodeUnknownSync(LocalTime)(row.day_start),
		timeZone:
			row.timezone === null
				? null
				: Schema.decodeUnknownSync(IanaTimeZone)(row.timezone),
		reminderDelay:
			row.reminder_delay_ms === null
				? null
				: Schema.decodeUnknownSync(DurationMillis)(
						safeInteger(row.reminder_delay_ms, 1),
					),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	return Schema.decodeUnknownSync(PetFoodSettings)(value);
};
const decodeEntry = (raw: unknown) => {
	const row = Schema.decodeUnknownSync(EntryRow)(raw);
	return {
		id: row.id,
		petId: row.pet_id,
		recordedBy: row.recorded_by,
		amountMg: Schema.decodeUnknownSync(FoodAmountMg)(
			safeInteger(row.amount_mg, 1),
		),
		fedAt: row.fed_at,
		sourceBotId: Schema.decodeUnknownSync(BotId)(row.source_bot_id),
		sourceUpdateId: safeInteger(row.source_update_id),
		sourceMessageChatId:
			row.source_message_chat_id === null
				? null
				: Schema.decodeUnknownSync(TelegramChatId)(
						safeInteger(row.source_message_chat_id, Number.MIN_SAFE_INTEGER),
					),
		sourceMessageId:
			row.source_message_id === null
				? null
				: safeInteger(row.source_message_id, 1),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
};
const decodeOne = <A>(
	rows: ReadonlyArray<unknown>,
	decode: (raw: unknown) => A,
): A => {
	if (rows.length !== 1 || rows[0] === undefined)
		throw new Error('Expected one row');
	return decode(rows[0]);
};

const traceService = <Service extends object>(
	prefix: string,
	service: Service,
): Service => {
	Object.assign(
		service,
		Object.fromEntries(
			Object.entries(service).map(([method, operation]) => [
				method,
				typeof operation === 'function'
					? (...args: Array<never>) =>
							operation(...args).pipe(Effect.withSpan(`${prefix}.${method}`))
					: operation,
			]),
		),
	);

	return service;
};

export const layer = Layer.effect(
	PetFoodRepository,
	Effect.map(PgClient.PgClient, (sql) => {
		const settings = (petId: string) =>
			sql<
				Record<string, unknown>
			>`SELECT pet_id,to_char(day_start,'HH24:MI') AS day_start,timezone,reminder_delay_ms,created_at,updated_at FROM carneloot.pet_food_settings WHERE pet_id=${petId}::uuid`;
		const entries = <E>(
			fragment: Effect.Effect<ReadonlyArray<Record<string, unknown>>, E>,
		) =>
			protect(fragment, 'Pet food query failed').pipe(
				Effect.flatMap((rows) =>
					Effect.try({
						try: () => rows.map(decodeEntry),
						catch: (cause) => invariant('Malformed pet food row', cause),
					}),
				),
			);
		const service = {
			lockOwnedPet: (ownerId, petId) =>
				protect(
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`SELECT * FROM carneloot.pets WHERE id=${petId}::uuid AND owner_id=${ownerId}::uuid FOR UPDATE`,
						(rows) =>
							rows[0] === undefined
								? Effect.fail(
										new PetAccessDenied({
											message: 'Pet is not owned by user',
										}),
									)
								: Effect.try({
										try: () => decodePet(rows[0]),
										catch: (cause) => invariant('Malformed pet row', cause),
									}),
					),
					'Pet ownership query failed',
				),
			getSettings: (petId) =>
				protect(settings(petId), 'Settings query failed').pipe(
					Effect.flatMap((rows) =>
						rows[0] === undefined
							? Effect.succeed(undefined)
							: Effect.try({
									try: () => decodeSettings(rows[0]),
									catch: (cause) => invariant('Malformed settings row', cause),
								}),
					),
				),
			setDayStart: (petId, dayStart, timeZone, now) =>
				protect(
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`INSERT INTO carneloot.pet_food_settings (pet_id,day_start,timezone,created_at,updated_at) VALUES (${petId}::uuid,${dayStart}::time,${timeZone},${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) ON CONFLICT (pet_id) DO UPDATE SET day_start=EXCLUDED.day_start,timezone=EXCLUDED.timezone,updated_at=EXCLUDED.updated_at RETURNING pet_id,to_char(day_start,'HH24:MI') AS day_start,timezone,reminder_delay_ms,created_at,updated_at`,
						(rows) =>
							Effect.try({
								try: () => decodeOne(rows, decodeSettings),
								catch: (cause) => invariant('Malformed settings row', cause),
							}),
					),
					'Settings update failed',
				),
			setReminderDelay: (petId, delay, now) =>
				protect(
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`INSERT INTO carneloot.pet_food_settings (pet_id,reminder_delay_ms,created_at,updated_at) VALUES (${petId}::uuid,${Duration.toMillis(delay)},${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) ON CONFLICT (pet_id) DO UPDATE SET reminder_delay_ms=EXCLUDED.reminder_delay_ms,updated_at=EXCLUDED.updated_at RETURNING pet_id,to_char(day_start,'HH24:MI') AS day_start,timezone,reminder_delay_ms,created_at,updated_at`,
						(rows) =>
							Effect.try({
								try: () => decodeOne(rows, decodeSettings),
								catch: (cause) => invariant('Malformed settings row', cause),
							}),
					),
					'Delay update failed',
				),
			clearReminderDelay: (petId, now) =>
				protect(
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`INSERT INTO carneloot.pet_food_settings (pet_id,created_at,updated_at) VALUES (${petId}::uuid,${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) ON CONFLICT (pet_id) DO UPDATE SET reminder_delay_ms=NULL,updated_at=EXCLUDED.updated_at RETURNING pet_id,to_char(day_start,'HH24:MI') AS day_start,timezone,reminder_delay_ms,created_at,updated_at`,
						(rows) =>
							Effect.try({
								try: () => decodeOne(rows, decodeSettings),
								catch: (cause) => invariant('Malformed settings row', cause),
							}),
					),
					'Delay deletion failed',
				),
			latestEntry: (petId) =>
				Effect.map(
					entries(
						sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid ORDER BY fed_at DESC,created_at DESC,id DESC LIMIT 1`,
					),
					(rows) => rows[0],
				),
			listEntries: (petId, start, end) =>
				entries(
					sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND fed_at>=${DateTime.toDateUtc(start)} AND fed_at<${DateTime.toDateUtc(end)} ORDER BY fed_at DESC,id DESC`,
				),
			lockEntry: (petId, entryId) =>
				Effect.map(
					entries(
						sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND id=${entryId}::uuid FOR UPDATE`,
					),
					(rows) => rows[0],
				),
			lockAccessibleBySourceMessage: (actorId, botId, chatId, messageId) =>
				entries(
					sql`SELECT e.* FROM carneloot.pet_food_entries e JOIN carneloot.pets p ON p.id=e.pet_id WHERE e.source_bot_id=${botId} AND e.source_message_chat_id=${chatId} AND e.source_message_id=${messageId} AND (p.owner_id=${actorId}::uuid OR EXISTS (SELECT 1 FROM carneloot.pet_caregivers c WHERE c.pet_id=p.id AND c.caregiver_user_id=${actorId}::uuid AND c.status='accepted')) ORDER BY e.pet_id,e.id FOR UPDATE OF e,p`,
				),
			findBySource: (petId, botId, updateId) =>
				Effect.map(
					entries(
						sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND source_bot_id=${botId} AND source_update_id=${updateId}`,
					),
					(rows) => rows[0],
				),
			findBusinessDuplicate: (petId, fedAt) =>
				Effect.map(
					entries(
						sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND abs(extract(epoch FROM (fed_at-${DateTime.toDateUtc(fedAt)}::timestamptz))*1000) < 60000 ORDER BY fed_at DESC,created_at DESC,id DESC LIMIT 1`,
					),
					(rows) => rows[0],
				),
			findBusinessDuplicateExcluding: (petId, fedAt, excludedEntryId) =>
				Effect.map(
					entries(
						sql`SELECT * FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND id<>${excludedEntryId}::uuid AND abs(extract(epoch FROM (fed_at-${DateTime.toDateUtc(fedAt)}::timestamptz))*1000) < 60000 ORDER BY fed_at DESC,created_at DESC,id DESC LIMIT 1`,
					),
					(rows) => rows[0],
				),
			insert: (entry) =>
				protect(
					Effect.flatMap(
						sql<
							Record<string, unknown>
						>`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,source_message_chat_id,source_message_id,created_at,updated_at) VALUES (${entry.id}::uuid,${entry.petId}::uuid,${entry.recordedBy}::uuid,${entry.amountMg},${DateTime.toDateUtc(entry.fedAt)},${entry.source.botId},${entry.source.updateId},${entry.source.messageChatId},${entry.source.messageId},${DateTime.toDateUtc(entry.now)},${DateTime.toDateUtc(entry.now)}) RETURNING *`,
						(rows) =>
							Effect.try({
								try: () => decodeOne(rows, decodeEntry),
								catch: (cause) =>
									invariant('Malformed inserted food row', cause),
							}),
					),
					'Food insert failed',
				),
			updateEntry: (entryId, amountMg, fedAt, now) =>
				Effect.map(
					entries(
						sql`UPDATE carneloot.pet_food_entries SET amount_mg=${amountMg},fed_at=${DateTime.toDateUtc(fedAt)},updated_at=${DateTime.toDateUtc(now)} WHERE id=${entryId}::uuid RETURNING *`,
					),
					(rows) => rows[0],
				),
			deleteEntry: (entryId) =>
				Effect.map(
					entries(
						sql`DELETE FROM carneloot.pet_food_entries WHERE id=${entryId}::uuid RETURNING *`,
					),
					(rows) => rows[0],
				),
			status: (petId, start, end) =>
				protect(
					Effect.flatMap(
						sql<{
							total_mg: string | number;
							latest_fed_at: unknown | null;
						}>`SELECT coalesce(sum(amount_mg),0) AS total_mg,max(fed_at) AS latest_fed_at FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid AND fed_at>=${DateTime.toDateUtc(start)} AND fed_at<${DateTime.toDateUtc(end)}`,
						(rows) =>
							Effect.try({
								try: () => {
									const row = rows[0];
									if (row === undefined)
										throw new Error('Missing aggregate row');
									return {
										totalMg: safeInteger(row.total_mg),
										latestFedAt:
											row.latest_fed_at === null
												? null
												: Schema.decodeUnknownSync(Timestamp)(
														row.latest_fed_at,
													),
									};
								},
								catch: (cause) => invariant('Malformed status row', cause),
							}),
					),
					'Status query failed',
				),
		} satisfies PetFoodRepositoryService;
		return traceService('PetFoodRepository', service);
	}),
);
