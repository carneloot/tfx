import * as Cloudflare from '@alchemy.run/cloudflare';
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
		const worker = yield* Cloudflare.Worker('Bot', {
			main: './src/cloudflare/Worker.ts',
			compatibility: { date: '2026-07-30', flags: ['nodejs_compat'] },
			crons: ['* * * * *'],
			limits: { cpuMs: 30_000 },
			env: {
				HYPERDRIVE: database,
				CHAT_DISPATCH: Cloudflare.DurableObject('ChatDispatch'),
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
