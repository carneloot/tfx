import * as Runtime from '@tfx/cloudflare/Runtime';
import * as Schema from 'effect/Schema';

import { botId } from '../bot/Declaration.js';
import { BotId } from '../domain/Ids.js';
import * as Hosting from '../http/Hosting.js';
import * as Router from '../Router.js';
import * as Application from './Runtime.js';

const hosting = Runtime.make({
	botId,
	// 10s ping + 5s Telegram output + 5s acquisition/bookkeeping. The DO's
	// 30s input gate still reserves 10s for interruption and scoped cleanup.
	dispatchTimeout: '20 seconds',
	layer: Application.layer,
	router: (env) => Router.make(env.BOT_USERNAME),
	beforeJobs: Application.recoverNotifications,
});

export const ChatDispatch = hosting.ChatDispatch;
export const JobWakeup = hosting.JobWakeup;
const worker: typeof hosting.worker = {
	...hosting.worker,
	fetch: (request, env, context) =>
		new URL(request.url).pathname === '/api/notify'
			? Hosting.fetch(
					request,
					Schema.decodeUnknownSync(BotId)(botId),
					Application.layer(env),
				)
			: hosting.worker.fetch(request, env, context),
};
export default worker;
