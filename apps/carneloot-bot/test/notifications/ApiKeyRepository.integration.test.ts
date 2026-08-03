import { createHash, randomUUID } from 'node:crypto';

import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { UserId } from '../../src/domain/Ids.js';
import { ApiKeyHash } from '../../src/domain/notifications/ApiKey.js';
import { ApiKeyRepository } from '../../src/ports/ApiKeyRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
);
const hash = (key: string) =>
	Schema.decodeUnknownSync(ApiKeyHash)(
		createHash('sha256').update(key).digest('hex'),
	);

if (!enabled)
	describe.skip('API key PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('API key PostgreSQL', () => {
		it('stores only SHA-256 hash and replaces one key per user', async () => {
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient;
						const userId = Schema.decodeUnknownSync(UserId)(randomUUID());
						yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${userId}::uuid,now(),now())`;
						const repository = yield* ApiKeyRepository;
						const first = hash('first');
						const second = hash('second');
						yield* repository.replaceForUser(userId, first);
						yield* repository.replaceForUser(userId, second);
						return {
							first: yield* repository.findUserIdByHash(first),
							second: yield* repository.findUserIdByHash(second),
							has: yield* repository.hasForUser(userId),
						};
					}),
					layer,
				),
			);
			expect(result).toEqual({ first: undefined, second: expect.any(String), has: true });
		});
	});
