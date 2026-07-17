import * as Job from 'tfx/Job';

import * as DispatchNotificationDelivery from '../application/DispatchNotificationDelivery.js';
import { declaration } from './FoodAddedNotificationJob.js';

export const implementation = Job.implement(
	declaration,
	DispatchNotificationDelivery.executeFoodAdded,
);
