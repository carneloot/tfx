import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';

import { hasUpload, toFormData } from './Multipart.js';

export const request = (
	client: HttpClient.HttpClient,
	url: string,
	payload: Readonly<Record<string, unknown>>,
) => {
	const base = HttpClientRequest.post(url);
	const req = hasUpload(payload)
		? HttpClientRequest.bodyFormData(base, toFormData(payload))
		: HttpClientRequest.bodyJsonUnsafe(base, payload);
	return Effect.flatMap(client.execute(req), (response) => response.json);
};
