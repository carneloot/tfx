import type * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Router } from 'tfx/BotRouter';
import * as BotRuntimeLive from 'tfx/BotRuntime';
import * as Conversations from 'tfx/Conversations';
import { JobRuntime } from 'tfx/JobRuntime';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import * as Middleware from 'tfx/Middleware';
import type { Telegram } from 'tfx/Telegram';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { Carneloot } from './bot/Declaration.js';
import * as RegisteredUser from './bot/RegisteredUser.js';
import type { AppConfigService } from './Config.js';
import * as FeedingReminderJobLive from './jobs/FeedingReminderJobLive.js';
import * as JobWorkerLive from './JobWorker.js';
import { NotificationRepository } from './ports/NotificationRepository.js';
import { migrate } from './postgres/AppMigrator.js';
import * as NotificationRecipientsLive from './postgres/NotificationRecipientsLive.js';
import * as NotificationRepositoryLive from './postgres/NotificationRepositoryLive.js';
import * as PetFoodRepositoryLive from './postgres/PetFoodRepositoryLive.js';
import * as PetRepositoryLive from './postgres/PetRepositoryLive.js';
import * as ReminderSchedulerLive from './postgres/ReminderSchedulerLive.js';
import * as UserRepositoryLive from './postgres/UserRepositoryLive.js';
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

/** Minimal runtime topology for tests supplying already-built infrastructure. */
export const core = <
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
	InfrastructureOut,
	E,
	R,
>(
	config: AppConfigService,
	options: {
		readonly delivery: D;
		readonly router: Router;
		readonly infrastructure: Layer.Layer<
			| InfrastructureOut
			| JobRuntime
			| NotificationRepository
			| UpdateDeduplicator,
			E,
			R
		>;
	},
) => {
	const bot = Layer.provide(
		BotRuntimeLive.layer(Carneloot, {
			delivery: options.delivery,
			...runtimeOptions(config, options.router),
		}),
		options.infrastructure,
	);
	const worker = Layer.provide(
		JobWorkerLive.layer(workerOptions(config)),
		options.infrastructure,
	);
	const runtimes = Layer.merge(bot, worker);
	return Layer.provideMerge(runtimes, options.infrastructure);
};

/** Portable topological graph with one externally supplied PostgreSQL Layer. */
export const portable = <
	PgE,
	PgR,
	TelegramE,
	TelegramR,
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
>(
	config: AppConfigService,
	options: {
		readonly pg: Layer.Layer<PgClient.PgClient, PgE, PgR>;
		readonly telegram: Layer.Layer<Telegram, TelegramE, TelegramR>;
		readonly delivery: D;
		readonly botUsername: string;
	},
) => {
	const stores = Layer.provide(
		TfxPostgres.layer({
			schema: config.tfxSchema,
			tablePrefix: config.tfxTablePrefix,
		}),
		options.pg,
	);
	const repositories = Layer.provide(
		Layer.unwrap(
			Effect.as(
				migrate,
				Layer.mergeAll(
					UserRepositoryLive.layer,
					PetRepositoryLive.layer,
					PetFoodRepositoryLive.layer,
					NotificationRepositoryLive.layer,
					NotificationRecipientsLive.layer,
				),
			),
		),
		options.pg,
	);
	const conversationsAndStores = Layer.provideMerge(
		Conversations.layer,
		stores,
	);
	const middlewareDependencies = Layer.merge(repositories, options.telegram);
	const middlewareAndDependencies = Layer.provideMerge(
		Middleware.layer(RegisteredUser.live),
		middlewareDependencies,
	);
	// These branches are independent: their internal dependencies are already
	// satisfied above, while PgClient remains available downstream.
	const foundation = Layer.mergeAll(
		options.pg,
		conversationsAndStores,
		middlewareAndDependencies,
	);
	const jobsAndFoundation = Layer.provideMerge(
		JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
		foundation,
	);
	const application = Layer.provideMerge(
		ReminderSchedulerLive.layer,
		jobsAndFoundation,
	);
	const bot = Layer.provide(
		Layer.unwrap(
			Effect.map(AppRouter.make(options.botUsername), (router) =>
				BotRuntimeLive.layer(Carneloot, {
					delivery: options.delivery,
					...runtimeOptions(config, router),
				}),
			),
		),
		application,
	);
	const worker = Layer.provide(
		JobWorkerLive.layer(workerOptions(config)),
		application,
	);
	const runtimes = Layer.merge(bot, worker);
	return Layer.provideMerge(runtimes, application);
};
