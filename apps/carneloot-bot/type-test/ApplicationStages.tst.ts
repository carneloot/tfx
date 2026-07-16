import type * as Layer from 'effect/Layer';
import { Conversations } from 'tfx/Conversations';
import { JobRuntime } from 'tfx/JobRuntime';
import { MiddlewareRegistry } from 'tfx/Middleware';

import { layer } from '../src/DomainLive.js';
import { ReminderScheduler } from '../src/ports/ReminderScheduler.js';

type Assert<T extends true> = T;
type Includes<Whole, Part> = [Part] extends [Whole] ? true : false;

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
