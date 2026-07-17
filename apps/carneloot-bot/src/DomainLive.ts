import * as Layer from 'effect/Layer';
import * as Conversations from 'tfx/Conversations';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import * as Middleware from 'tfx/Middleware';

import * as RegisteredUser from './bot/RegisteredUser.js';
import * as FeedingReminderJobLive from './jobs/FeedingReminderJobLive.js';
import * as FoodAddedNotificationJobLive from './jobs/FoodAddedNotificationJobLive.js';
import * as FoodNotificationSchedulerLive from './postgres/FoodNotificationSchedulerLive.js';
import * as ReminderSchedulerLive from './postgres/ReminderSchedulerLive.js';

const core = Layer.mergeAll(
	Conversations.layer,
	Middleware.layer(RegisteredUser.live),
	JobRuntimeLive.layer(
		FeedingReminderJobLive.implementation,
		FoodAddedNotificationJobLive.implementation,
	),
);

export const layer = Layer.provideMerge(
	Layer.merge(ReminderSchedulerLive.layer, FoodNotificationSchedulerLive.layer),
	core,
);
