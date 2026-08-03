import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Encoding from 'effect/Encoding';
import * as Schema from 'effect/Schema';

import type { UserId } from '../domain/Ids.js';
import { ApiKeyHash } from '../domain/notifications/ApiKey.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';

const encoder = new TextEncoder();

export const execute = Effect.fn('GenerateApiKey.execute')((userId: UserId) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const repository = yield* ApiKeyRepository;
		const key = Encoding.encodeBase64Url(
			yield* crypto.randomBytes(32).pipe(Effect.orDie),
		);
		const digest = yield* crypto
			.digest('SHA-256', encoder.encode(key))
			.pipe(Effect.orDie);
		const hash = Schema.decodeUnknownSync(ApiKeyHash)(Encoding.encodeHex(digest));
		yield* repository.replaceForUser(userId, hash);
		return key;
	}),
);
