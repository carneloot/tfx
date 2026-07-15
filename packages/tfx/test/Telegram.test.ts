import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import type * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import { describe, expect, it } from 'vitest';

import { make } from '../src/Telegram.js';

const success = {
	ok: true,
	result: { message_id: 7, date: 1, chat: { id: 42, type: 'private' } },
};
const run = (
	body: unknown,
	inspect?: (request: HttpClientRequest.HttpClientRequest) => void,
	status = 200,
	raw = false,
) => {
	const client = HttpClient.make((request) => {
		inspect?.(request);
		const responseBody = raw ? String(body) : JSON.stringify(body);
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(responseBody, {
					status,
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
	});
	return <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
		Effect.runPromise(
			Effect.provideService(effect, HttpClient.HttpClient, client),
		);
};

const expectJson =
	(expected: object) => (request: HttpClientRequest.HttpClientRequest) => {
		expect(request.body._tag).toBe('Uint8Array');
		expect(request.headers['content-type']).toContain('application/json');
		if (request.body._tag === 'Uint8Array')
			expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual(
				expected,
			);
	};

describe('Telegram', () => {
	it('sends sendMessage as JSON and strips successful envelope', async () => {
		const payload = { chat_id: 42, text: 'oi' };
		const execute = run(success, (request) => {
			expect(request.url).toBe(
				'https://api.telegram.org/bot123456:secret/sendMessage',
			);
			expectJson(payload)(request);
		});
		await expect(
			execute(
				Effect.flatMap(make(Redacted.make('123456:secret')), (telegram) =>
					telegram.sendMessage(payload),
				),
			),
		).resolves.toMatchObject({ message_id: 7 });
	});
	it.each(['file-id', 'https://example.com/document.pdf'])(
		'sends document string %s as JSON',
		async (document) => {
			const payload = { chat_id: 42, document };
			const execute = run(success, expectJson(payload));
			await execute(
				Effect.flatMap(make(Redacted.make('1:x')), (telegram) =>
					telegram.sendDocument(payload),
				),
			);
		},
	);
	it('sends Blob uploads as multipart form data', async () => {
		const execute = run(success, (request) => {
			expect(request.body._tag).toBe('FormData');
			expect(request.headers['content-type']).toBeUndefined();
			if (request.body._tag === 'FormData') {
				expect(request.body.formData.get('chat_id')).toBe('42');
				expect(request.body.formData.get('document')).toBeInstanceOf(Blob);
			}
		});
		await execute(
			Effect.flatMap(make(Redacted.make('1:x')), (telegram) =>
				telegram.sendDocument({ chat_id: 42, document: new Blob(['data']) }),
			),
		);
	});
	it.each([
		[400, 'InvalidRequestError'],
		[401, 'AuthenticationError'],
		[403, 'ForbiddenError'],
		[409, 'ConflictError'],
		[429, 'RateLimitError'],
		[500, 'InternalTelegramError'],
	] as const)('maps HTTP %i Telegram envelope', async (status, tag) => {
		const execute = run(
			{
				ok: false,
				error_code: status,
				description: 'safe',
				parameters: { retry_after: 2 },
			},
			undefined,
			status,
		);
		await expect(
			execute(
				Effect.flatMap(make(Redacted.make('1:x')), (telegram) =>
					telegram.getUpdates(),
				),
			),
		).rejects.toMatchObject({ reason: { _tag: tag } });
	});
	it.each([
		['not json', true],
		[{ ok: true }, false],
	])(
		'maps malformed JSON/success envelopes to InvalidResponseError',
		async (body, raw) => {
			const execute = run(body, undefined, 200, raw);
			await expect(
				execute(
					Effect.flatMap(make(Redacted.make('1:x')), (telegram) =>
						telegram.getMe(),
					),
				),
			).rejects.toMatchObject({ reason: { _tag: 'InvalidResponseError' } });
		},
	);
});
