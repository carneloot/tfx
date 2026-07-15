import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientError from 'effect/unstable/http/HttpClientError';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';

import { make as makeGenerated } from './internal/telegram/generated/TelegramApi.runtime.js';
import type { TelegramApi } from './internal/telegram/generated/TelegramApi.types.js';
import { safeMessage } from './internal/telegram/Sanitize.js';
import {
	fromEnvelope,
	InvalidResponseError,
	NetworkError,
	TelegramError,
	UnknownError,
	type TelegramFailureEnvelope,
} from './TelegramError.js';

type UnwrapEnvelope<A> = A extends {
	readonly ok: true;
	readonly result: infer Result;
}
	? Result
	: A;
type DirectOperation<F> = F extends (options: {
	readonly payload: infer Payload;
	readonly config?: unknown;
}) => Effect.Effect<infer Success, unknown, infer Requirements>
	? {} extends Payload
		? (
				payload?: Payload,
			) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
		: (
				payload: Payload,
			) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
	: F extends (options?: {
				readonly payload?: infer Payload;
		  }) => Effect.Effect<infer Success, unknown, infer Requirements>
		? (
				payload?: Payload,
			) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
		: never;
export type TelegramService = {
	readonly [Method in keyof TelegramApi]: DirectOperation<TelegramApi[Method]>;
};

export class Telegram extends Context.Service<Telegram, TelegramService>()(
	'tfx/Telegram',
) {}

const mapGeneratedError = (method: string, cause: unknown): TelegramError => {
	const tagged =
		typeof cause === 'object' && cause !== null
			? (cause as { readonly _tag?: unknown; readonly cause?: unknown })
			: undefined;
	if (tagged?._tag === 'APIResponseError')
		return fromEnvelope(method, tagged.cause as TelegramFailureEnvelope);

	if (HttpClientError.isHttpClientError(cause)) {
		const reason =
			cause.reason._tag === 'TransportError'
				? new NetworkError({ message: 'Telegram network request failed' })
				: cause.reason._tag === 'DecodeError' ||
					  cause.reason._tag === 'EmptyBodyError'
					? new InvalidResponseError({
							message: 'Telegram response could not be decoded',
						})
					: new UnknownError({ message: 'Telegram HTTP request failed' });
		return new TelegramError({ module: 'Telegram', method, reason });
	}

	const reason =
		tagged?._tag === 'SchemaError'
			? new InvalidResponseError({
					message: 'Telegram response did not match expected schema',
				})
			: new UnknownError({
					message: safeMessage('Unknown Telegram client failure'),
				});
	return new TelegramError({ module: 'Telegram', method, reason });
};

export const make = (
	token: Redacted.Redacted<string>,
): Effect.Effect<TelegramService, never, HttpClient.HttpClient> =>
	Effect.map(HttpClient.HttpClient, (client) => {
		const baseUrl = `https://api.telegram.org/bot${Redacted.value(token)}`;
		const generated = makeGenerated(
			HttpClient.mapRequest(client, HttpClientRequest.prependUrl(baseUrl)),
		);
		return new Proxy({} as TelegramService, {
			get: (_target, property) => {
				if (typeof property !== 'string') return undefined;
				const operation = generated[
					property as keyof TelegramApi
				] as unknown as (options: {
					payload: unknown;
				}) => Effect.Effect<unknown, unknown>;
				return (payload: unknown = {}) =>
					operation({ payload }).pipe(
						Effect.map((envelope) => (envelope as { result: unknown }).result),
						Effect.mapError((cause) => mapGeneratedError(property, cause)),
					);
			},
		});
	});

export const layer = (
	token: Redacted.Redacted<string>,
): Layer.Layer<Telegram, never, HttpClient.HttpClient> =>
	Layer.effect(Telegram, make(token));
