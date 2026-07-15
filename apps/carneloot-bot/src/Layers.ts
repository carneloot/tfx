import type * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Router } from 'tfx/BotRouter';
import { BotRuntime } from 'tfx/BotRuntime';
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
import { JobWorker } from './JobWorker.js';
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

export const core = <
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
	E,
	R,
>(
	config: AppConfigService,
	options: {
		readonly delivery: D;
		readonly router: Router;
		readonly infrastructure: Layer.Layer<
			JobRuntime | NotificationRepository | UpdateDeduplicator,
			E,
			R
		>;
	},
): Layer.Layer<BotRuntime | JobWorker | UpdateDeduplicator, unknown, R> => {
	const bot = Layer.provide(
		BotRuntimeLive.layer(Carneloot, {
			delivery: options.delivery,
			capacity: config.dispatchCapacity,
			concurrency: config.dispatchConcurrency,
			leaseDuration: config.dedupLeaseMillis,
			waitTimeout: config.dedupWaitMillis,
			retention: config.dedupRetentionMillis,
			heartbeatInterval: config.dedupHeartbeatMillis,
			router: options.router,
		}),
		options.infrastructure,
	);
	const worker = Layer.provide(
		JobWorkerLive.layer({
			idleDelay: config.jobIdleMillis,
			leaseDuration: config.jobLeaseMillis,
			heartbeatInterval: config.jobHeartbeatMillis,
		}),
		options.infrastructure,
	);
	return Layer.mergeAll(bot, worker, options.infrastructure) as never;
};

export const portable = <
	E,
	R,
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
>(
	config: AppConfigService,
	options: {
		readonly pg: Layer.Layer<PgClient.PgClient, E, R>;
		readonly telegram: Layer.Layer<Telegram>;
		readonly delivery: D;
		readonly botUsername: string;
	},
): Layer.Layer<BotRuntime | JobWorker | UpdateDeduplicator, unknown, R> => {
	const tfx = Layer.provide(
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
	const conversations = Layer.provide(Conversations.layer, tfx);
	const middleware = Layer.provide(
		Middleware.layer(RegisteredUser.live),
		repositories,
	);
	const common = Layer.mergeAll(
		tfx,
		repositories,
		conversations,
		middleware,
		options.telegram,
		options.pg,
	);
	const jobs = Layer.provide(
		JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
		common,
	);
	const scheduler = Layer.provide(
		ReminderSchedulerLive.layer,
		Layer.merge(common, jobs),
	);
	const application = Layer.mergeAll(common, jobs, scheduler);
	const bot = Layer.provide(
		Layer.unwrap(
			Effect.map(AppRouter.make(options.botUsername), (router) =>
				BotRuntimeLive.layer(Carneloot, {
					delivery: options.delivery,
					capacity: config.dispatchCapacity,
					concurrency: config.dispatchConcurrency,
					leaseDuration: config.dedupLeaseMillis,
					waitTimeout: config.dedupWaitMillis,
					retention: config.dedupRetentionMillis,
					heartbeatInterval: config.dedupHeartbeatMillis,
					router,
				}),
			),
		),
		application,
	);
	const worker = Layer.provide(
		JobWorkerLive.layer({
			idleDelay: config.jobIdleMillis,
			leaseDuration: config.jobLeaseMillis,
			heartbeatInterval: config.jobHeartbeatMillis,
		}),
		application,
	);
	return Layer.mergeAll(bot, worker, tfx) as never;
};
