import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

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
import type { RegisteredUser, TelegramProfile } from '../domain/User.js';
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
	created_at: Schema.Unknown,
	updated_at: Schema.Unknown,
});
const time = (value: unknown) => {
	const result =
		value instanceof Date
			? value.getTime()
			: new Date(value as string).getTime();
	if (!Number.isFinite(result)) throw new Error('Invalid timestamp');
	return result;
};
const safeUserId = (value: string | number) =>
	Schema.decodeUnknownSync(TelegramUserId)(Number(value));
const safeChatId = (value: string | number) =>
	Schema.decodeUnknownSync(TelegramChatId)(Number(value));
const decode = (
	value: unknown,
): Effect.Effect<RegisteredUser, DomainPersistenceError> =>
	Effect.try({
		try: () => {
			const row = Schema.decodeUnknownSync(Row)(value);
			return {
				user: {
					id: row.id,
					createdAt: time(row.created_at),
					updatedAt: time(row.updated_at),
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
			new DomainPersistenceError({ message: 'Malformed user row', cause }),
	});
const persistence = (cause: unknown): DomainPersistenceError =>
	cause instanceof DomainPersistenceError
		? cause
		: new DomainPersistenceError({ message: 'User repository failed', cause });
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

export const layer: Layer.Layer<
	UserRepository,
	DomainPersistenceError,
	PgClient.PgClient
> = Layer.effect(
	UserRepository,
	Effect.map(PgClient.PgClient, (sql) => {
		const validateProfile = (profile: TelegramProfile) =>
			Effect.all([
				Schema.decodeUnknownEffect(BotId)(profile.botId),
				Schema.decodeUnknownEffect(TelegramUserId)(profile.telegramUserId),
				Schema.decodeUnknownEffect(TelegramChatId)(profile.privateChatId),
			]).pipe(Effect.mapError(persistence), Effect.asVoid);
		const service: UserRepositoryService = {
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
								const now = yield* Clock.currentTimeMillis;
								const timestamp = new Date(now);
								if (existing[0] !== undefined) {
									yield* sql`UPDATE carneloot.telegram_identities SET username=${profile.username},first_name=${profile.firstName},last_name=${profile.lastName},private_chat_id=${profile.privateChatId},updated_at=${timestamp} WHERE bot_id=${profile.botId} AND telegram_user_id=${profile.telegramUserId}`;
									yield* sql`UPDATE carneloot.users SET updated_at=${timestamp} WHERE id=${existing[0].id as string}::uuid`;
									const refreshed = yield* select(
										sql,
										profile.botId,
										profile.telegramUserId,
									);
									return yield* decode(refreshed[0]);
								}
								const id = crypto.randomUUID();
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
						.pipe(Effect.mapError(persistence)),
				),
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
		};
		return service;
	}),
);
