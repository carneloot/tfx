import type {
	DurableObject,
	DurableObjectNamespace,
	DurableObjectState,
	ExportedHandler,
	Request as WorkerRequest,
} from '@cloudflare/workers-types';
import * as Schema from 'effect/Schema';
import { timingSafeEqual } from 'node:crypto';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import * as Partitioning from 'tfx/Partitioning';
import { Update } from 'tfx/TelegramSchemas';
import * as UpdateRoutingScope from 'tfx/UpdateRoutingScope';

export interface Bindings {
	readonly CHAT_DISPATCH: DurableObjectNamespace;
	readonly JOB_WAKEUP: DurableObjectNamespace;
	readonly WEBHOOK_SECRET: string;
}

export interface Application<Env extends Bindings> {
	readonly botId: string;
	/** Run and close the scoped application graph for this event. */
	readonly dispatch: (
		env: Env,
		update: typeof Update.Type,
	) => Promise<DispatchOutcome.DispatchOutcome>;
	/** Reconcile SQL schedules, arm the native alarm, then acknowledge the outbox. */
	readonly reconcile: (
		env: Env,
		arm: (deadline: number | undefined) => Promise<void>,
	) => Promise<void>;
	readonly runJobs: (env: Env) => Promise<void>;
}

export interface Hosting<Env extends Bindings> {
	readonly worker: ExportedHandler<Env> & {
		readonly fetch: NonNullable<ExportedHandler<Env>['fetch']>;
	};
	readonly ChatDispatch: new (
		state: DurableObjectState,
		env: Env,
	) => DurableObject;
	readonly JobWakeup: new (
		state: DurableObjectState,
		env: Env,
	) => DurableObject;
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

export const make = <Env extends Bindings>(
	application: Application<Env>,
): Hosting<Env> => ({
	worker: {
		async fetch(request: WorkerRequest, env: Env): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (path === '/health' && request.method === 'GET')
				return new Response('ok');
			if (path !== '/telegram')
				return new Response('Not found', { status: 404 });
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
				UpdateRoutingScope.fromUpdate(application.botId, input.update),
			);
			try {
				// The internal request deliberately does not inherit the caller's abort
				// signal. Once accepted, the DO settles processing and dedup even if
				// Telegram disconnects, and holds the chat gate until cleanup completes.
				const response = await env.CHAT_DISPATCH.getByName(String(key)).fetch(
					new Request('https://dispatch.internal/telegram', {
						method: 'POST',
						body: JSON.stringify(input.update),
					}),
				);
				// Dispatch has settled and released its chat gate. Handoff failure
				// must not turn committed output into a resend. Cron recovers SQL intents.
				try {
					const handoff = await env.JOB_WAKEUP.getByName(
						application.botId,
					).fetch(
						new Request('https://wakeup.internal/reconcile', {
							method: 'POST',
						}),
					);
					if (!handoff.ok) console.error('tfx.cloudflare.handoff_failed');
				} catch {
					console.error('tfx.cloudflare.handoff_failed');
				}
				return response;
			} catch {
				return new Response('Retry later', { status: 503 });
			}
		},
		async scheduled(_event: unknown, env: Env): Promise<void> {
			const response = await env.JOB_WAKEUP.getByName(application.botId).fetch(
				new Request('https://wakeup.internal/reconcile', { method: 'POST' }),
			);
			if (!response.ok) throw new Error('Job wakeup reconciliation failed');
		},
	} satisfies ExportedHandler<Env>,

	/** Native HTTP Durable Object, with no application data stored outside SQL. */
	ChatDispatch: class ChatDispatch implements DurableObject {
		constructor(
			private readonly state: DurableObjectState,
			private readonly env: Env,
		) {}

		fetch(request: WorkerRequest): Promise<Response> {
			return this.state.blockConcurrencyWhile(async () => {
				const input = await readUpdate(request);
				if ('status' in input)
					return new Response('Invalid update', { status: input.status });
				const env = this.env;
				try {
					// Await processing AND scoped finalizers before acknowledging or opening
					// the input gate. Runtime's deadline must leave cleanup time below DO's
					// 30s limit for SQL cancellation, rollback, claim release and pool closure.
					const outcome = await application.dispatch(env, input.update);
					return new Response(
						DispatchOutcome.isAcknowledgeable(outcome) ? 'ok' : 'Retry later',
						{ status: DispatchOutcome.isAcknowledgeable(outcome) ? 200 : 503 },
					);
				} catch {
					// Never log causes here: SQL/HTTP diagnostics may contain credentials.
					console.error('tfx.cloudflare.processing_failed', {
						updateId: input.update.update_id,
					});
					return new Response('Retry later', { status: 503 });
				}
			});
		}
	},

	JobWakeup: class JobWakeup implements DurableObject {
		constructor(
			private readonly state: DurableObjectState,
			private readonly env: Env,
		) {}
		private reconcile() {
			return application.reconcile(this.env, async (deadline) => {
				if (deadline === undefined) await this.state.storage.deleteAlarm();
				else
					await this.state.storage.setAlarm(
						Math.max(Date.now() + 100, deadline),
					);
			});
		}
		fetch(): Promise<Response> {
			return this.state.blockConcurrencyWhile(async () => {
				await this.reconcile();
				return new Response('ok');
			});
		}
		alarm(): Promise<void> {
			return this.state.blockConcurrencyWhile(async () => {
				// Persist recovery before claiming SQL work. Eviction/reset must not
				// strand an execution lease, including after Cloudflare's alarm retries.
				await this.state.storage.setAlarm(Date.now() + 30_000);
				try {
					await application.runJobs(this.env);
					await this.reconcile();
				} catch {
					console.error('tfx.cloudflare.alarm_failed');
					throw new Error('Job alarm failed');
				}
			});
		}
	},
});
