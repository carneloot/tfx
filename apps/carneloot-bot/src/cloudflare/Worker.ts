import type {
	DurableObject,
	DurableObjectNamespace,
	DurableObjectState,
	ExportedHandler,
	Request as WorkerRequest,
} from '@cloudflare/workers-types';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { timingSafeEqual } from 'node:crypto';
import * as BotRuntime from 'tfx/BotRuntime';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import * as Partitioning from 'tfx/Partitioning';
import { Update } from 'tfx/TelegramSchemas';
import * as UpdateRoutingScope from 'tfx/UpdateRoutingScope';

import { botId } from '../bot/Declaration.js';
import * as Router from '../Router.js';
import * as Runtime from './Runtime.js';

interface Env extends Runtime.Env {
	readonly CHAT_DISPATCH: DurableObjectNamespace;
}

const maxBodyBytes = 1_048_576;
const secretPattern = /^[A-Za-z0-9_-]{32,256}$/u;

// Bound streamed bodies too, not just Content-Length, which callers control.
const readUpdate = async (request: WorkerRequest) => {
	const reader = request.body?.getReader();
	if (reader === undefined) return { status: 400 } as const;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBodyBytes) {
				await reader.cancel();
				return { status: 413 } as const;
			}
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const update = Schema.decodeUnknownSync(Update)(
			JSON.parse(
				new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
					bytes,
				),
			),
		);
		if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
			return { status: 400 } as const;
		return { update } as const;
	} catch {
		return { status: 400 } as const;
	} finally {
		reader.releaseLock();
	}
};

export default {
	async fetch(request: WorkerRequest, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === '/health' && request.method === 'GET')
			return new Response('ok');
		if (path !== '/telegram') return new Response('Not found', { status: 404 });
		if (request.method !== 'POST')
			return new Response('Method not allowed', {
				status: 405,
				headers: { Allow: 'POST' },
			});
		if (!secretPattern.test(env.WEBHOOK_SECRET))
			return new Response('Not configured', { status: 503 });
		const supplied = new TextEncoder().encode(
			request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '',
		);
		const expected = new TextEncoder().encode(env.WEBHOOK_SECRET);
		if (
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		)
			return new Response('Forbidden', { status: 403 });
		const input = await readUpdate(request);
		if ('status' in input)
			return new Response('Invalid update', { status: input.status });
		const key = Partitioning.byChat(
			UpdateRoutingScope.fromUpdate(botId, input.update),
		);
		try {
			// The internal request deliberately does not inherit the caller's abort
			// signal. Once accepted, the DO settles processing and dedup even if
			// Telegram disconnects, and holds the chat gate until cleanup completes.
			return await env.CHAT_DISPATCH.getByName(String(key)).fetch(
				new Request('https://dispatch.internal/telegram', {
					method: 'POST',
					body: JSON.stringify(input.update),
				}),
			);
		} catch {
			return new Response('Retry later', { status: 503 });
		}
	},
	async scheduled(_event: unknown, env: Runtime.Env): Promise<void> {
		await Effect.runPromise(
			Runtime.drainJobs.pipe(
				Effect.provide(Runtime.layer(env)),
				Effect.timeout('40 seconds'),
				Effect.catchTag('TimeoutError', () =>
					Effect.logWarning('carneloot.cloudflare.cron_deadline'),
				),
				Effect.asVoid,
			),
		);
	},
} satisfies ExportedHandler<Env>;

/** Native HTTP Durable Object, with no application data stored outside SQL. */
export class ChatDispatch implements DurableObject {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Runtime.Env,
	) {}

	fetch(request: WorkerRequest): Promise<Response> {
		return this.state.blockConcurrencyWhile(async () => {
			const input = await readUpdate(request);
			if ('status' in input)
				return new Response('Invalid update', { status: input.status });
			const env = this.env;
			try {
				// Await processing AND scoped finalizers before acknowledging or opening
				// the input gate. The 10s deadline leaves 20s for SQL cancellation,
				// transaction rollback, claim release and pool closure before DO's 30s gate.
				const outcome = await Effect.runPromise(
					Effect.gen(function* () {
						const router = yield* Router.make(env.BOT_USERNAME);
						return yield* BotRuntime.dispatch(input.update, router);
					}).pipe(
						Effect.provide(Runtime.layer(env)),
						Effect.timeout('10 seconds'),
						Effect.tap((outcome) =>
							Effect.logInfo('carneloot.cloudflare.update').pipe(
								Effect.annotateLogs({
									updateId: input.update.update_id,
									outcome: outcome._tag,
								}),
							),
						),
					),
				);
				return new Response(
					DispatchOutcome.isAcknowledgeable(outcome) ? 'ok' : 'Retry later',
					{ status: DispatchOutcome.isAcknowledgeable(outcome) ? 200 : 503 },
				);
			} catch {
				// Never log causes here: SQL/HTTP diagnostics may contain credentials.
				console.error('carneloot.cloudflare.processing_failed', {
					updateId: input.update.update_id,
				});
				return new Response('Retry later', { status: 503 });
			}
		});
	}
}
