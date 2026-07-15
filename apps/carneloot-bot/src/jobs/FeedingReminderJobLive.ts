import * as Job from 'tfx/Job';

import * as DispatchNotificationDelivery from '../application/DispatchNotificationDelivery.js';
import { declaration } from './FeedingReminderJob.js';

export const implementation = Job.implement(
	declaration,
	DispatchNotificationDelivery.execute,
);
