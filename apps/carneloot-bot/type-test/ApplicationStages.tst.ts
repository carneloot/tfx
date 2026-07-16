import type * as PgClient from '@effect/sql-pg/PgClient';
import type * as Layer from 'effect/Layer';
import { BotRuntime } from 'tfx/BotRuntime';
import { Conversations } from 'tfx/Conversations';
import { JobRuntime } from 'tfx/JobRuntime';
import { MiddlewareRegistry } from 'tfx/Middleware';
import type { Telegram } from 'tfx/Telegram';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import * as UpdateDelivery from 'tfx/UpdateDelivery';

import * as AppLive from '../src/AppLive.js';
import { AppConfig } from '../src/Config.js';
import { layer } from '../src/DomainLive.js';
import { JobWorker } from '../src/JobWorker.js';
import { ReminderScheduler } from '../src/ports/ReminderScheduler.js';
import * as RuntimeLive from '../src/RuntimeLive.js';
import { testConfig } from '../test/internal/TestConfig.js';

type Assert<T extends true> = T;
type Includes<Whole, Part> = [Part] extends [Whole] ? true : false;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

export type DomainProvidesConversations = Assert<
	Includes<Layer.Success<typeof layer>, Conversations>
>;
export type DomainProvidesMiddleware = Assert<
	Includes<Layer.Success<typeof layer>, MiddlewareRegistry>
>;
export type DomainProvidesJobs = Assert<
	Includes<Layer.Success<typeof layer>, JobRuntime>
>;
export type DomainProvidesScheduler = Assert<
	Includes<Layer.Success<typeof layer>, ReminderScheduler>
>;

const runtime = RuntimeLive.layer(testConfig, UpdateDelivery.manual);

export type RuntimeOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof runtime>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;

const application = AppLive.layer(() => UpdateDelivery.manual);

export type AppOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof application>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;
export type AppRequirementsAreInfrastructure = Assert<
	Equal<
		Layer.Services<typeof application>,
		AppConfig | PgClient.PgClient | Telegram
	>
>;
