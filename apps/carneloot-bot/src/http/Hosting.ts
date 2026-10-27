import type * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as Layer from 'effect/Layer';

import type * as SendExternalNotification from '../application/SendExternalNotification.js';
import type { BotId } from '../domain/Ids.js';
import * as ApiLive from './ApiLive.js';

export type Requirements = Effect.Services<
	ReturnType<typeof SendExternalNotification.execute>
>;

/** Construct and close the application graph for each Worker fetch, never at module scope. */
export const fetch = async <E>(
	request: Request,
	botId: BotId,
	application: Layer.Layer<Requirements, E>,
) => {
	const web = HttpRouter.toWebHandler(
		ApiLive.layer(botId).pipe(
			Layer.provideMerge(application),
			Layer.provide(HttpServer.layerServices),
		),
		{ disableLogger: true },
	);
	try {
		// Client disconnect must not interrupt an already claimed non-idempotent send.
		return await web.handler(
			new Request(request, { signal: new AbortController().signal }),
		);
	} finally {
		await web.dispose();
	}
};
