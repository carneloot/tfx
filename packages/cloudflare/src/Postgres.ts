import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as PgClient from '@effect/sql-pg/PgClient';
import type { Options } from '@tfx/postgres/Options';
import * as PostgresJobWakeup from '@tfx/postgres/PostgresJobWakeup';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Telegram from 'tfx/Telegram';

export interface Bindings {
	readonly HYPERDRIVE: { readonly connectionString: string };
	readonly BOT_TOKEN: string;
}

/** One scoped pool per invocation. No migrations or connections retained across events. */
export const layer = (env: Bindings, options: Options) =>
	Layer.provideMerge(
		Layer.merge(
			TfxPostgres.servicesLayer(options),
			PostgresJobWakeup.layer(options),
		),
		Layer.mergeAll(
			PgClient.layer({
				url: Redacted.make(env.HYPERDRIVE.connectionString),
				prepare: false,
				maxConnections: 3,
				connectTimeout: '5 seconds',
				acquireTimeout: '5 seconds',
			}),
			Layer.provide(
				Telegram.layer(Redacted.make(env.BOT_TOKEN), { timeout: '5 seconds' }),
				FetchHttpClient.layer,
			),
			NodeCrypto.layer,
		),
	);
