import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
for (const packageName of ['tfx', '@tfx/postgres']) {
	const manifestPath = join(
		dirname(require.resolve(packageName)),
		'..',
		'package.json',
	);
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
		exports: Record<string, string>;
	};
	for (const subpath of Object.keys(manifest.exports)) {
		if (subpath === './package.json') continue;
		await import(
			subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`
		);
	}
}
const publicTfx = await import('tfx');
const MessageHandler = await import('tfx/MessageHandler');
const MessageInput = await import('tfx/MessageInput');
const MessageHandlerResult = await import('tfx/MessageHandlerResult');
if (
	publicTfx.MessageHandler !== MessageHandler ||
	publicTfx.MessageInput !== MessageInput ||
	publicTfx.MessageHandlerResult !== MessageHandlerResult ||
	typeof MessageHandler.make !== 'function' ||
	typeof MessageInput.replyText !== 'function' ||
	MessageHandlerResult.handled._tag !== 'Handled'
)
	throw new Error('Packed typed message-handler public API failed');
const Telegram = await import('tfx/Telegram');
const client = HttpClient.make((request) =>
	Effect.succeed(
		HttpClientResponse.fromWeb(
			request,
			new Response(
				JSON.stringify({
					ok: true,
					result: { message_id: 7, date: 1, chat: { id: 42, type: 'private' } },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		),
	),
);
const message = await Effect.runPromise(
	Effect.provideService(
		Effect.flatMap(
			Telegram.make(Redacted.make('123456:packed-test')),
			(service) => service.sendMessage({ chat_id: 42, text: 'packed facade' }),
		),
		HttpClient.HttpClient,
		client,
	),
);
if (message.message_id !== 7)
	throw new Error('Packed Telegram facade call failed');
process.stdout.write('packed-consumer-ok\n');
