import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
const containerLayer = Layer.unwrap(
	Effect.map(
		Effect.acquireRelease(
			Effect.promise(() =>
				new PostgreSqlContainer('postgres:17-alpine').start(),
			),
			(container) => Effect.promise(() => container.stop()).pipe(Effect.asVoid),
		),
		(container) =>
			PgClient.layer({ url: Redacted.make(container.getConnectionUri()) }),
	),
);
export const layer =
	process.env.TEST_DATABASE_URL === undefined
		? containerLayer
		: PgClient.layer({ url: Redacted.make(process.env.TEST_DATABASE_URL) });
