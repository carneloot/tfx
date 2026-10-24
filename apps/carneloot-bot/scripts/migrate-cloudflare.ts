import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxMigrations from '@tfx/postgres/Migrations';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';

import * as AppMigrator from '../src/postgres/AppMigrator.js';

// Explicit operator command. Never imported by the Worker or Alchemy stack.
NodeRuntime.runMain(
	Effect.gen(function* () {
		const url = yield* Config.Redacted('DATABASE_URL');
		const schema = yield* Config.String('TFX_POSTGRES_SCHEMA');
		const tablePrefix = yield* Config.String('TFX_POSTGRES_TABLE_PREFIX');
		yield* Effect.all(
			[TfxMigrations.migrate({ schema, tablePrefix }), AppMigrator.migrate],
			{
				concurrency: 1,
			},
		).pipe(Effect.provide(PgClient.layer({ url, prepare: false })));
	}),
);
