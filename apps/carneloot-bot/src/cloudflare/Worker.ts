import * as Runtime from '@tfx/cloudflare/Runtime';

import { botId } from '../bot/Declaration.js';
import * as Router from '../Router.js';
import * as Application from './Runtime.js';

const hosting = Runtime.make({
	botId,
	layer: Application.layer,
	router: (env) => Router.make(env.BOT_USERNAME),
	beforeJobs: Application.recoverNotifications,
});

export const ChatDispatch = hosting.ChatDispatch;
export const JobWakeup = hosting.JobWakeup;
export default hosting.worker;
