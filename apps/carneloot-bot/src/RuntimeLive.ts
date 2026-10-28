import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as BotRuntimeLive from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { Carneloot } from './bot/Declaration.js';
import * as ForwardToOwner from './bot/ForwardToOwner.js';
import type { AppConfigService } from './Config.js';
import * as JobWorkerLive from './JobWorker.js';
import * as AppRouter from './Router.js';

export const layer = <D extends UpdateDelivery.UpdateDelivery<any, any, any>>(
	config: AppConfigService,
	delivery: D,
) => {
	const bot = Layer.unwrap(
		Effect.map(AppRouter.make(config.botUsername), (router) =>
			BotRuntimeLive.layer(Carneloot, {
				delivery,
				capacity: config.dispatchCapacity,
				concurrency: config.dispatchConcurrency,
				leaseDuration: config.dedupLease,
				waitTimeout: config.dedupWait,
				retention: config.dedupRetention,
				heartbeatInterval: config.dedupHeartbeat,
				router,
			}),
		).pipe(Effect.provideService(ForwardToOwner.Settings, config.forwarding)),
	);
	const worker = JobWorkerLive.layer({
		idleDelay: config.jobIdle,
		leaseDuration: config.jobLease,
		heartbeatInterval: config.jobHeartbeat,
	});
	const deduplicator = Layer.effect(UpdateDeduplicator, UpdateDeduplicator);
	return Layer.mergeAll(bot, worker, deduplicator);
};
