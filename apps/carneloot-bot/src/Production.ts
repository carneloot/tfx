import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Polling from 'tfx/Polling';
import * as Telegram from 'tfx/Telegram';

import { menuCommands } from './bot/Declaration.js';
import { AppConfig, type AppConfigService } from './Config.js';
import * as AppConfigLive from './Config.js';
import * as Layers from './Layers.js';

export const pollingOptions = (config: AppConfigService) =>
	({
		timeout: config.pollingTimeoutSeconds,
		retryDelay: config.pollingRetryDelayMillis,
		allowedUpdates: Object.freeze([
			'message',
			'edited_message',
			'channel_post',
			'edited_channel_post',
			'business_message',
			'edited_business_message',
			'message_reaction',
			'callback_query',
			'my_chat_member',
			'chat_member',
			'chat_join_request',
		]),
		commands: menuCommands,
		languageCode: 'pt',
	}) satisfies Polling.Options;

export const fromConfig = (config: AppConfigService) => {
	const pg = PgClient.layer({ url: config.databaseUrl });
	const telegram = Layer.provide(
		Telegram.layer(config.botToken),
		BunHttpClient.layer,
	);
	return Layers.portable(config, {
		pg,
		telegram,
		delivery: Polling.make(pollingOptions(config)),
		botUsername: config.botUsername,
	});
};
const configuredLayer = Layer.unwrap(Effect.map(AppConfig, fromConfig));
export const appLayer = Layer.provide(configuredLayer, AppConfigLive.layer);
