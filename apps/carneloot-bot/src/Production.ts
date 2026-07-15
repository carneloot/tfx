import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Polling from 'tfx/Polling';
import * as Telegram from 'tfx/Telegram';

import { AppConfig, type AppConfigService } from './Config.js';
import * as Layers from './Layers.js';

export const fromConfig = (config: AppConfigService) => {
	const pg = PgClient.layer({ url: config.databaseUrl });
	const telegram = Layer.provide(
		Telegram.layer(config.botToken),
		BunHttpClient.layer,
	);
	return Layers.portable(config, {
		pg,
		telegram,
		delivery: Polling.make({
			timeout: config.pollingTimeoutSeconds,
			retryDelay: config.pollingRetryDelayMillis,
		}),
		botUsername: config.botUsername,
	});
};
export const layer = Layer.unwrap(Effect.map(AppConfig, fromConfig));
