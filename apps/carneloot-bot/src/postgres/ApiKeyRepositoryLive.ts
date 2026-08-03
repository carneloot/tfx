import * as PgClient from '@effect/sql-pg/PgClient';
import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { traceService } from 'tfx/TraceService';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { UserId } from '../domain/Ids.js';
import { ApiKeyHash, ApiKeyId } from '../domain/notifications/ApiKey.js';
import {
	ApiKeyRepository,
	type ApiKeyRepositoryService,
} from '../ports/ApiKeyRepository.js';

const persistence = (cause: unknown) =>
	cause instanceof DomainPersistenceError
		? cause
		: new DomainPersistenceError({
				reason: 'PersistenceFailure',
				message: 'API key repository failed',
				cause,
			});

export const layer = Layer.effect(
	ApiKeyRepository,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const crypto = yield* Crypto.Crypto;
		const service = {
			hasForUser: (userId) =>
				sql<{ readonly exists: boolean }>`SELECT EXISTS(SELECT 1 FROM carneloot.api_keys WHERE user_id=${userId}::uuid) AS exists`.pipe(
					Effect.map((rows) => rows[0]?.exists ?? false),
					Effect.mapError(persistence),
				),
			replaceForUser: (userId, keyHash) =>
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(ApiKeyHash)(keyHash).pipe(
						Effect.mapError(persistence),
					);
					const now = DateTime.toDateUtc(yield* DateTime.now);
					const id = Schema.decodeUnknownSync(ApiKeyId)(
						yield* crypto.randomUUIDv4.pipe(Effect.orDie),
					);
					yield* sql`INSERT INTO carneloot.api_keys (id,user_id,key_hash,created_at,updated_at)
						VALUES (${id}::uuid,${userId}::uuid,${keyHash},${now},${now})
						ON CONFLICT (user_id) DO UPDATE SET key_hash=EXCLUDED.key_hash,updated_at=EXCLUDED.updated_at`;
				}).pipe(Effect.mapError(persistence)),
			findUserIdByHash: (keyHash) =>
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(ApiKeyHash)(keyHash).pipe(
						Effect.mapError(persistence),
					);
					const rows = yield* sql<Record<string, unknown>>`SELECT user_id FROM carneloot.api_keys WHERE key_hash=${keyHash}`;
					return rows[0] === undefined
						? undefined
						: yield* Schema.decodeUnknownEffect(UserId)(rows[0].user_id).pipe(
							Effect.mapError(persistence),
						);
				}).pipe(Effect.mapError(persistence)),
		} satisfies ApiKeyRepositoryService;
		return traceService('ApiKeyRepository', service);
	}),
);
