import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { createServer } from 'node:http';
import * as Polling from 'tfx/Polling';
import * as Telegram from 'tfx/Telegram';

import * as AppLive from './AppLive.js';
import { botId, menuCommands } from './bot/Declaration.js';
import { AppConfig, type AppConfigService } from './Config.js';
import * as AppConfigLive from './Config.js';
import { BotId } from './domain/Ids.js';
import * as ApiLive from './http/ApiLive.js';

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
			Layer.provide(Telegram.layer(config.botToken), FetchHttpClient.layer),
			BunCrypto.layer,
		),
	),
);
const http = HttpRouter.serve(
	ApiLive.layer(Schema.decodeUnknownSync(BotId)(botId)),
	{ disableLogger: true },
).pipe(
	Layer.provide(
		Layer.unwrap(
			Effect.map(Config.Port('PORT').pipe(Config.withDefault(3000)), (port) =>
				NodeHttpServer.layer(createServer, { port }),
			),
		),
	),
);
const application = Layer.provideMerge(
	http,
	AppLive.layer((config) => Polling.make(pollingOptions(config))),
).pipe(Layer.provide(AppLive.applicationLayer), Layer.provide(infrastructure));
export const appLayer = Layer.provide(application, AppConfigLive.layer);
