import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { ConversationStorage } from 'tfx/ConversationStorage';
import { JobStore } from 'tfx/JobStore';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import * as TfxPostgres from '../src/TfxPostgres.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
describe.skipIf(!enabled)('PostgreSQL aggregate Layer', () => {
	it('provides all adapters from one externally provided client', async () => {
		const options = {
			schema: 'tfx_layers_test',
			tablePrefix: 'case_',
			botId: 'test',
		};
		const aggregate = Layer.provide(
			TfxPostgres.layer(options),
			PostgresTestLayer.layer,
		);
		const program = Effect.gen(function* () {
			yield* ConversationStorage;
			yield* JobStore;
			yield* UpdateDeduplicator;
			const sql = yield* PgClient.PgClient;
			return yield* sql<{
				current_database: string;
			}>`SELECT current_database()`;
		});
		const rows = await Effect.runPromise(
			Effect.provide(program, Layer.merge(aggregate, PostgresTestLayer.layer)),
		);
		expect(rows).toHaveLength(1);
	});
});
