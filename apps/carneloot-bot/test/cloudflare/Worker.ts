import type { DurableObjectState, Request } from '@cloudflare/workers-types';
import type { Bindings } from '@tfx/cloudflare/Worker';

import type { Env } from '../../src/cloudflare/Runtime.js';
import { JobWakeup as NativeJobWakeup } from '../../src/cloudflare/Worker.js';

export { default, ChatDispatch } from '../../src/cloudflare/Worker.js';

/** Test-only control of real workerd alarms, never exposed by the public Worker. */
export class JobWakeup extends NativeJobWakeup {
	constructor(
		private readonly context: DurableObjectState,
		env: Env & Bindings,
	) {
		super(context, env);
	}
	async fetch(request: Request): Promise<Response> {
		switch (new URL(request.url).pathname) {
			case '/fail-next-handoff':
				await this.context.storage.put('failNextHandoff', true);
				return new Response('ok');
			case '/alarm':
				await this.alarm?.();
				return new Response('ok');
			case '/state':
				return Response.json({ alarm: await this.context.storage.getAlarm() });
		}
		if (await this.context.storage.get('failNextHandoff')) {
			await this.context.storage.delete('failNextHandoff');
			return new Response('Injected handoff failure', { status: 503 });
		}
		const fetch = super.fetch;
		if (fetch === undefined) throw new Error('Missing native fetch');
		return fetch.call(this, request);
	}
}
