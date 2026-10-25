import * as Cloudflare from '@alchemy.run/cloudflare';
import * as TfxCloudflare from '@tfx/cloudflare/Alchemy';
import * as Alchemy from 'alchemy';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';

export default Alchemy.Stack(
	'carneloot',
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const database = yield* Cloudflare.Hyperdrive.Connection('Postgres', {
			origin: {
				scheme: 'postgres',
				host: yield* Config.String('POSTGRES_HOST'),
				port: yield* Config.Int('POSTGRES_PORT').pipe(Config.withDefault(5432)),
				database: yield* Config.String('POSTGRES_DATABASE'),
				user: yield* Config.String('POSTGRES_USER'),
				password: yield* Config.Redacted('POSTGRES_PASSWORD'),
			},
			// Access checks, dedup claims and job fencing must never read cached rows.
			caching: { disabled: true },
		});
		const worker = yield* TfxCloudflare.worker('Bot', {
			main: './src/cloudflare/Worker.ts',
			env: {
				HYPERDRIVE: database,
				BOT_TOKEN: Config.Redacted('BOT_TOKEN'),
				BOT_USERNAME: Config.String('BOT_USERNAME'),
				WEBHOOK_SECRET: Config.Redacted('WEBHOOK_SECRET'),
				TFX_POSTGRES_SCHEMA: Config.String('TFX_POSTGRES_SCHEMA'),
				TFX_POSTGRES_TABLE_PREFIX: Config.String('TFX_POSTGRES_TABLE_PREFIX'),
			},
		});
		return { url: worker.url };
	}),
);
