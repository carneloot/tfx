import * as PgClient from '@effect/sql-pg/PgClient';
import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { traceService } from 'tfx/TraceService';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);

import {
	DomainPersistenceError,
	UserNotRegistered,
} from '../domain/DomainError.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../domain/Ids.js';
import type { TelegramProfile } from '../domain/User.js';
import {
	UserRepository,
	type UserRepositoryService,
} from '../ports/UserRepository.js';

const Row = Schema.Struct({
	id: UserId,
	bot_id: BotId,
	telegram_user_id: Schema.Union([Schema.String, Schema.Number]),
	username: Schema.NullOr(Schema.String),
	first_name: Schema.String,
	last_name: Schema.NullOr(Schema.String),
	private_chat_id: Schema.Union([Schema.String, Schema.Number]),
	created_at: Timestamp,
	updated_at: Timestamp,
});
const safeUserId = (value: string | number) =>
	Schema.decodeUnknownSync(TelegramUserId)(Number(value));
const safeChatId = (value: string | number) =>
	Schema.decodeUnknownSync(TelegramChatId)(Number(value));
const decode = (value: unknown) =>
	Effect.try({
		try: () => {
			const row = Schema.decodeUnknownSync(Row)(value);
			return {
				user: {
					id: row.id,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				},
				profile: {
					botId: row.bot_id,
					telegramUserId: safeUserId(row.telegram_user_id),
					username: row.username,
					firstName: row.first_name,
					lastName: row.last_name,
					privateChatId: safeChatId(row.private_chat_id),
				},
			};
		},
		catch: (cause) =>
			new DomainPersistenceError({
				reason: 'InvariantViolation',
				message: 'Malformed user row',
				cause,
			}),
	});
const persistence = (cause: unknown) =>
	cause instanceof DomainPersistenceError
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'User repository failed',
				cause,
			});
const select = (
	sql: PgClient.PgClient,
	botId: string,
	telegramUserId: number,
) =>
	sql<
		Record<string, unknown>
	>`SELECT u.id,i.bot_id,i.telegram_user_id,i.username,i.first_name,i.last_name,i.private_chat_id,u.created_at,u.updated_at
	FROM carneloot.telegram_identities i JOIN carneloot.users u ON u.id=i.user_id
	WHERE i.bot_id=${botId} AND i.telegram_user_id=${telegramUserId}`;

export const layer = Layer.effect(
	UserRepository,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const crypto = yield* Crypto.Crypto;
		const validateProfile = (profile: TelegramProfile) =>
			Effect.all([
				Schema.decodeUnknownEffect(BotId)(profile.botId),
				Schema.decodeUnknownEffect(TelegramUserId)(profile.telegramUserId),
				Schema.decodeUnknownEffect(TelegramChatId)(profile.privateChatId),
			]).pipe(Effect.mapError(persistence), Effect.asVoid);
		const service = {
			registerTelegramProfile: (profile: TelegramProfile) =>
				Effect.andThen(
					validateProfile(profile),
					sql
						.withTransaction(
							Effect.gen(function* () {
								const lockKey = JSON.stringify([
									profile.botId,
									profile.telegramUserId,
								]);
								yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
								const existing = yield* select(
									sql,
									profile.botId,
									profile.telegramUserId,
								);
								const now = yield* DateTime.now;
								const timestamp = DateTime.toDateUtc(now);
								if (existing[0] !== undefined) {
									yield* sql`UPDATE carneloot.telegram_identities SET username=${profile.username},first_name=${profile.firstName},last_name=${profile.lastName},private_chat_id=${profile.privateChatId},updated_at=${timestamp} WHERE bot_id=${profile.botId} AND telegram_user_id=${profile.telegramUserId}`;
									const existingUserId = Schema.decodeUnknownSync(UserId)(
										existing[0].id,
									);
									yield* sql`UPDATE carneloot.users SET updated_at=${timestamp} WHERE id=${existingUserId}::uuid`;
									const refreshed = yield* select(
										sql,
										profile.botId,
										profile.telegramUserId,
									);
									return yield* decode(refreshed[0]);
								}
								const id = Schema.decodeUnknownSync(UserId)(
									yield* crypto.randomUUIDv4.pipe(Effect.orDie),
								);
								yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${id}::uuid,${timestamp},${timestamp})`;
								yield* sql`INSERT INTO carneloot.telegram_identities (bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES (${profile.botId},${profile.telegramUserId},${id}::uuid,${profile.username},${profile.firstName},${profile.lastName},${profile.privateChatId},${timestamp},${timestamp})`;
								const created = yield* select(
									sql,
									profile.botId,
									profile.telegramUserId,
								);
								return yield* decode(created[0]);
							}),
						)
						.pipe(Effect.withSpan('UserRepository.transaction'))
						.pipe(Effect.mapError(persistence)),
				),
			findByUsername: (botId, username) =>
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(BotId)(botId).pipe(
						Effect.mapError(persistence),
					);
					const normalized = username.trim().replace(/^@/u, '').toLowerCase();
					const rows = yield* sql<
						Record<string, unknown>
					>`SELECT u.id,i.bot_id,i.telegram_user_id,i.username,i.first_name,i.last_name,i.private_chat_id,u.created_at,u.updated_at
					FROM carneloot.telegram_identities i JOIN carneloot.users u ON u.id=i.user_id
					WHERE i.bot_id=${botId} AND lower(i.username)=${normalized}
					ORDER BY u.id`.pipe(Effect.mapError(persistence));
					return yield* Effect.forEach(rows, decode);
				}),
			findById: (botId, userId) =>
				Effect.gen(function* () {
					yield* Effect.all([
						Schema.decodeUnknownEffect(BotId)(botId),
						Schema.decodeUnknownEffect(UserId)(userId),
					]).pipe(Effect.mapError(persistence));
					const rows = yield* sql<
						Record<string, unknown>
					>`SELECT u.id,i.bot_id,i.telegram_user_id,i.username,i.first_name,i.last_name,i.private_chat_id,u.created_at,u.updated_at
					FROM carneloot.telegram_identities i JOIN carneloot.users u ON u.id=i.user_id
					WHERE i.bot_id=${botId} AND u.id=${userId}::uuid`.pipe(
						Effect.mapError(persistence),
					);
					if (rows[0] === undefined)
						return yield* Effect.fail(
							new UserNotRegistered({
								message: 'User is not registered for bot',
							}),
						);
					return yield* decode(rows[0]);
				}),
			findByTelegram: (botId, telegramUserId) =>
				Effect.gen(function* () {
					yield* Effect.all([
						Schema.decodeUnknownEffect(BotId)(botId),
						Schema.decodeUnknownEffect(TelegramUserId)(telegramUserId),
					]).pipe(Effect.mapError(persistence));
					const rows = yield* select(sql, botId, telegramUserId).pipe(
						Effect.mapError(persistence),
					);
					if (rows[0] === undefined)
						return yield* Effect.fail(
							new UserNotRegistered({ message: 'User is not registered' }),
						);
					return yield* decode(rows[0]);
				}),
		} satisfies UserRepositoryService;
		return traceService('UserRepository', service);
	}),
);
