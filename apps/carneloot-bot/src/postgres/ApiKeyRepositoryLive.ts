import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { UserId } from '../domain/Ids.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';

// Do not retain SQL causes here: driver errors may contain key hashes or parameters.
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError(
			() =>
				new DomainPersistenceError({
					reason: 'PersistenceFailure',
					message: 'API key persistence failed',
				}),
		),
	);
export const layer = Layer.effect(
	ApiKeyRepository,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		return ApiKeyRepository.of({
			findOwner: Effect.fn('ApiKeyRepository.findOwner')(function* (hash) {
				const rows = yield* protect(
					sql`SELECT user_id FROM carneloot.api_keys WHERE key_hash=${hash}`,
				);
				if (rows[0] === undefined) return undefined;
				return yield* protect(
					Schema.decodeUnknownEffect(UserId)(rows[0].user_id),
				);
			}),
			replace: Effect.fn('ApiKeyRepository.replace')(function* ({
				id,
				userId,
				hash,
				confirmed,
			}) {
				const rows = yield* protect(sql`
				INSERT INTO carneloot.api_keys (id,user_id,key_hash,created_at,updated_at)
				VALUES (${id}::uuid,${userId}::uuid,${hash},now(),now())
				ON CONFLICT (user_id) DO UPDATE SET key_hash=EXCLUDED.key_hash,updated_at=EXCLUDED.updated_at
				WHERE ${confirmed} RETURNING id`);
				return rows.length > 0;
			}),
		});
	}),
);
