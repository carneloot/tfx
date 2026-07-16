import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Router } from 'tfx/BotRouter';
import * as BotRuntimeLive from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { Carneloot } from './bot/Declaration.js';
import type { AppConfigService } from './Config.js';
import * as JobWorkerLive from './JobWorker.js';
import * as AppRouter from './Router.js';

const runtimeOptions = (config: AppConfigService, router: Router) => ({
	capacity: config.dispatchCapacity,
	concurrency: config.dispatchConcurrency,
	leaseDuration: config.dedupLease,
	waitTimeout: config.dedupWait,
	retention: config.dedupRetention,
	heartbeatInterval: config.dedupHeartbeat,
	router,
});
const workerOptions = (config: AppConfigService) => ({
	idleDelay: config.jobIdle,
	leaseDuration: config.jobLease,
	heartbeatInterval: config.jobHeartbeat,
});

export const layer = <D extends UpdateDelivery.UpdateDelivery<any, any, any>>(
	config: AppConfigService,
	delivery: D,
) => {
	const bot = Layer.unwrap(
		Effect.map(AppRouter.make(config.botUsername), (router) =>
			BotRuntimeLive.layer(Carneloot, {
				delivery,
				...runtimeOptions(config, router),
			}),
		),
	);
	const worker = JobWorkerLive.layer(workerOptions(config));
	const deduplicator = Layer.effect(UpdateDeduplicator, UpdateDeduplicator);
	return Layer.mergeAll(bot, worker, deduplicator);
};
