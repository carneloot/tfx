import * as Layer from 'effect/Layer';
import * as Conversations from 'tfx/Conversations';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import * as Middleware from 'tfx/Middleware';

import * as RegisteredUser from './bot/RegisteredUser.js';
import * as FeedingReminderJobLive from './jobs/FeedingReminderJobLive.js';
import * as ReminderSchedulerLive from './postgres/ReminderSchedulerLive.js';

const core = Layer.mergeAll(
	Conversations.layer,
	Middleware.layer(RegisteredUser.live),
	JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
);

export const layer = Layer.provideMerge(ReminderSchedulerLive.layer, core);
