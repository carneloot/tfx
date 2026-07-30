import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Polling from 'tfx/Polling';
import * as Telegram from 'tfx/Telegram';

import * as AppLive from './AppLive.js';
import { menuCommands } from './bot/Declaration.js';
import { AppConfig, type AppConfigService } from './Config.js';
import * as AppConfigLive from './Config.js';

export const pollingOptions = (config: AppConfigService) =>
	({
		timeout: config.pollingTimeout,
		retryDelay: config.pollingRetryDelay,
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

const infrastructure = Layer.unwrap(
	Effect.map(AppConfig, (config) =>
		Layer.mergeAll(
			PgClient.layer({ url: config.databaseUrl }),
			Layer.provide(Telegram.layer(config.botToken), BunHttpClient.layer),
			BunCrypto.layer,
		),
	),
);
const application = Layer.provide(
	AppLive.layer((config) => Polling.make(pollingOptions(config))),
	infrastructure,
);
export const appLayer = Layer.provide(application, AppConfigLive.layer);
