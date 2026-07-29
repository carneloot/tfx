import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

import { resetIntegrationDatabase } from '../../../../packages/postgres/test/internal/ResetIntegrationDatabase.js';
const container = Layer.unwrap(
	Effect.map(
		Effect.acquireRelease(
			Effect.promise(() =>
				new PostgreSqlContainer('postgres:17-alpine').start(),
			),
			(value) => Effect.promise(() => value.stop()).pipe(Effect.asVoid),
		),
		(value) => PgClient.layer({ url: Redacted.make(value.getConnectionUri()) }),
	),
);
export const layer = (
	process.env.TEST_DATABASE_URL === undefined
		? container
		: PgClient.layer({ url: Redacted.make(process.env.TEST_DATABASE_URL) })
).pipe(
	Layer.tap((context) =>
		Effect.provideService(
			resetIntegrationDatabase,
			PgClient.PgClient,
			Context.get(context, PgClient.PgClient),
		),
	),
);
