import * as Cloudflare from '@alchemy.run/cloudflare';
import * as Planetscale from '@alchemy.run/planetscale';
import * as TfxCloudflare from '@tfx/cloudflare/Alchemy';
import * as Alchemy from 'alchemy';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import * as ForwardToOwner from './src/bot/ForwardToOwner.js';

export default Alchemy.Stack(
	'carneloot',
	{
		providers: Layer.provideMerge(
			Planetscale.providers(),
			Cloudflare.providers(),
		),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const forwarding = yield* ForwardToOwner.config;
		const runtimeRole = yield* Planetscale.PostgresRole('Runtime', {
			name: 'carneloot-worker',
			database: yield* Config.String('PLANETSCALE_DATABASE'),
			branch: yield* Config.String('PLANETSCALE_BRANCH').pipe(
				Config.withDefault('main'),
			),
			inheritedRoles: ['pg_read_all_data', 'pg_write_all_data'],
		});
		const database = yield* Cloudflare.Hyperdrive.Connection('Postgres', {
			origin: runtimeRole.origin,
			dev: runtimeRole.pooledOrigin,
			// Access checks, dedup claims and job fencing must never read cached rows.
			caching: { disabled: true },
		});
		const worker = yield* TfxCloudflare.worker('Bot', {
			main: './src/cloudflare/Worker.ts',
			env: {
				HYPERDRIVE: database,
				BOT_TOKEN: Config.Redacted('BOT_TOKEN'),
				BOT_USERNAME: Config.String('BOT_USERNAME'),
				TELEGRAM_FORWARD_USERNAMES: forwarding.usernames.join(','),
				...(forwarding.ownerChatId === undefined
					? {}
					: { OWNER_TELEGRAM_ID: String(forwarding.ownerChatId) }),
				WEBHOOK_SECRET: Config.Redacted('WEBHOOK_SECRET'),
				TFX_POSTGRES_SCHEMA: Config.String('TFX_POSTGRES_SCHEMA'),
				TFX_POSTGRES_TABLE_PREFIX: Config.String('TFX_POSTGRES_TABLE_PREFIX'),
			},
		});
		return { url: worker.url };
	}),
);
