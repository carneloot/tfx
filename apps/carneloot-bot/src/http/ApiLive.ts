import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { HttpApiSchemaError } from 'effect/http-api/HttpApiError';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Result from 'effect/Result';

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

const invalidRequestResponse = HttpRouter.middleware(
	(effect) =>
		Effect.catchCause(effect, (cause) => {
			const defect = Cause.findDefect(cause);
			return Result.isSuccess(defect) && HttpApiSchemaError.is(defect.success)
				? Effect.succeed(
						HttpServerResponse.jsonUnsafe(
							{
								_tag: 'InvalidNotificationRequest',
								message: 'Request payload is invalid.',
							},
							{ status: 400 },
						),
					)
				: Effect.failCause(cause);
		}),
	{ global: true },
);

export const layer = (botId: BotId) =>
	Layer.merge(
		HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers(botId))),
		invalidRequestResponse,
	);
