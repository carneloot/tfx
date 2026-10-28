import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';

import * as SendExternalNotification from '../application/SendExternalNotification.js';
import type { BotId } from '../domain/Ids.js';
import { Api } from './Api.js';

export const handlers = (botId: BotId) =>
	HttpApiBuilder.group(Api, 'notifications', (handlers) =>
		handlers.handle(
			'notify',
			({ payload }) => SendExternalNotification.execute(botId, payload),
			{ uninterruptible: true },
		),
	);
export const layer = (botId: BotId) =>
	HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers(botId)));
