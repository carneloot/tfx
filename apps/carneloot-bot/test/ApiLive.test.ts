import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';

import { BotId } from '../src/domain/Ids.js';
import * as ApiLive from '../src/http/ApiLive.js';

const botId = Schema.decodeUnknownSync(BotId)('carneloot');

describe('notification API', () => {
	it('returns safe feedback for a malformed notification request', async () => {
		const app = HttpRouter.toWebHandler(
			ApiLive.layer(botId).pipe(Layer.provide(HttpServer.layerServices)),
			{ disableLogger: true },
		);
		try {
			// The payload is rejected before a handler uses application services.
			// @ts-expect-error The full router still correctly requires them for valid requests.
			const response = await app.handler(
				new Request('https://bot.test/api/notify', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						apiKey: 'secret-api-key',
						keyword: 'alarm',
						variables: { pet: { secret: 'do-not-echo' } },
					}),
				}),
			);

			expect(response.status).toBe(400);
			const body = await response.json();
			expect(body).toEqual({
				_tag: 'InvalidNotificationRequest',
				message: 'Request payload is invalid.',
			});
			expect(JSON.stringify(body)).not.toContain('do-not-echo');
		} finally {
			await app.dispose();
		}
	});
});
