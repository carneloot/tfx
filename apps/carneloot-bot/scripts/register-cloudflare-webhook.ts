import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Telegram from 'tfx/Telegram';

import { menuCommands } from '../src/bot/Declaration.js';

// Explicit production write, separate from deploy. Run only after approval and
// after stopping getUpdates polling. Never drop Telegram's pending updates.
NodeRuntime.runMain(
	Effect.gen(function* () {
		const token = yield* Config.Redacted('BOT_TOKEN');
		const secret = yield* Config.Redacted('WEBHOOK_SECRET');
		const publicUrl = yield* Config.String('WORKER_URL');
		const url = new URL(publicUrl);
		if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
			return yield* Effect.die(
				new Error('WORKER_URL must be a public HTTPS origin'),
			);
		if (!/^[A-Za-z0-9_-]{32,256}$/u.test(Redacted.value(secret)))
			return yield* Effect.die(
				new Error('WEBHOOK_SECRET must contain 32–256 URL-safe characters'),
			);
		yield* Effect.gen(function* () {
			const telegram = yield* Telegram.Telegram;
			yield* telegram.setMyCommands({
				commands: [...menuCommands],
				language_code: 'pt',
			});
			yield* telegram.setWebhook({
				url: new URL('/telegram', url).href,
				secret_token: Redacted.value(secret),
				max_connections: 1,
				drop_pending_updates: false,
				allowed_updates: [
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
				],
			});
		}).pipe(
			Effect.provide(
				Layer.provide(Telegram.layer(token), FetchHttpClient.layer),
			),
		);
		yield* Effect.logInfo('carneloot.cloudflare.webhook_registered');
	}),
);
