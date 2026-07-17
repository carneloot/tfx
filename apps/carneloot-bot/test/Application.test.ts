import { Effect, Layer, Logger, References, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import * as AddPet from '../src/application/AddPet.js';
import * as ListPets from '../src/application/ListPets.js';
import * as RegisterUser from '../src/application/RegisterUser.js';
import {
	PetNameAlreadyExists,
	UserNotRegistered,
} from '../src/domain/DomainError.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const otherId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const profile = {
	botId,
	telegramUserId,
	username: null,
	firstName: 'Ana',
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
};
let insertions = 0;
const pets = Layer.succeed(PetRepository, {
	findById: () => Effect.die('unused'),
	lockById: () => Effect.die('unused'),
	deleteOwned: () => Effect.die('unused'),
	addOwned: (_ownerId, name) => {
		insertions++;
		return name === 'Rex'
			? Effect.succeed({
					id: '00000000-0000-4000-8000-000000000002' as never,
					ownerId,
					name,
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				})
			: Effect.fail(new PetNameAlreadyExists({ message: 'duplicate' }));
	},
	listOwned: () => Effect.succeed([]),
	listAccessible: () => Effect.succeed([]),
});
const users = (id = ownerId) =>
	Layer.succeed(UserRepository, {
		findById: () => Effect.die('unused'),
		findByUsername: () => Effect.succeed([]),
		registerTelegramProfile: () => Effect.die('unused'),
		findByTelegram: () =>
			Effect.succeed({
				user: {
					id,
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				},
				profile,
			}),
	});
const request = { ownerId, botId, telegramUserId, name: ' Rex ' };
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<{
		readonly message: unknown;
		readonly annotations: Readonly<Record<string, unknown>>;
	}> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.map(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		(result) => ({ result, logs }),
	);
};
describe('pet application services', () => {
	it('revalidates identity, normalizes, and logs the created pet', async () => {
		const { result: pet, logs } = await Effect.runPromise(
			captureLogs(
				Effect.provide(AddPet.execute(request), Layer.merge(pets, users())),
			),
		);
		expect(pet.name).toBe('Rex');
		expect(logs).toContainEqual({
			message: 'carneloot.pet.added',
			annotations: { ownerId, petId: pet.id },
		});
		expect(JSON.stringify(logs)).not.toContain(pet.name);
	});
	it('logs successful Telegram registration without profile PII', async () => {
		const sensitiveProfile = {
			...profile,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(424_242),
			username: 'private-username',
			firstName: 'private-first-name',
			lastName: 'private-last-name',
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(-424_242),
		};
		const registered = {
			user: {
				id: ownerId,
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
			},
			profile: sensitiveProfile,
		};
		const registration = Layer.succeed(UserRepository, {
			findById: () => Effect.die('unused'),
			findByUsername: () => Effect.succeed([]),
			registerTelegramProfile: () => Effect.succeed(registered),
			findByTelegram: () => Effect.die('unused'),
		});
		const { logs } = await Effect.runPromise(
			captureLogs(
				Effect.provide(RegisterUser.execute(sensitiveProfile), registration),
			),
		);
		expect(logs).toContainEqual({
			message: 'carneloot.user.profile_saved',
			annotations: { botId, userId: ownerId },
		});
		for (const pii of [
			sensitiveProfile.username,
			sensitiveProfile.firstName,
			sensitiveProfile.lastName,
			sensitiveProfile.telegramUserId,
			sensitiveProfile.privateChatId,
		])
			expect(JSON.stringify(logs)).not.toContain(String(pii));
	});
	it('rejects removed or remapped identities without insertion', async () => {
		insertions = 0;
		const removed = Layer.succeed(UserRepository, {
			findById: () => Effect.die('unused'),
			findByUsername: () => Effect.succeed([]),
			registerTelegramProfile: () => Effect.die('unused'),
			findByTelegram: () =>
				Effect.fail(new UserNotRegistered({ message: 'removed' })),
		});
		for (const identity of [removed, users(otherId)]) {
			const result = await Effect.runPromiseExit(
				Effect.provide(AddPet.execute(request), Layer.merge(pets, identity)),
			);
			expect(result).toMatchObject({ _tag: 'Failure' });
		}
		expect(insertions).toBe(0);
	});
	it('returns empty owned projections', async () => {
		expect(
			await Effect.runPromise(Effect.provide(ListPets.execute(ownerId), pets)),
		).toEqual([]);
	});
});
