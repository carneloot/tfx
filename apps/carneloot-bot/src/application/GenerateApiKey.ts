import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Hex from 'effect/encoding/Hex';

import { InvalidDomainInput } from '../domain/DomainError.js';
import type { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';
import { UserRepository } from '../ports/UserRepository.js';

export const hash = Effect.fn('GenerateApiKey.hash')(function* (key: string) {
	const crypto = yield* Crypto.Crypto;
	return Hex.encode(
		yield* crypto
			.digest('SHA-256', new TextEncoder().encode(key))
			.pipe(Effect.orDie),
	);
});

export const execute = Effect.fn('GenerateApiKey.execute')(function* (input: {
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly actorId: UserId;
	readonly confirmed: boolean;
}) {
	const users = yield* UserRepository;
	const actor = yield* users.findByTelegram(input.botId, input.telegramUserId);
	if (actor.user.id !== input.actorId)
		return yield* new InvalidDomainInput({ message: 'API key actor mismatch' });
	const crypto = yield* Crypto.Crypto;
	const key = Hex.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
	const repository = yield* ApiKeyRepository;
	const replaced = yield* repository.replace({
		id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
		userId: input.actorId,
		hash: yield* hash(key),
		confirmed: input.confirmed,
	});
	return replaced
		? { _tag: 'Issued' as const, key }
		: { _tag: 'ConfirmationRequired' as const };
});
