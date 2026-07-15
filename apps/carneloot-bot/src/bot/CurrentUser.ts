import * as Context from 'effect/Context';

import type { RegisteredUser } from '../domain/User.js';
export class CurrentUser extends Context.Service<CurrentUser, RegisteredUser>()(
	'carneloot/CurrentUser',
) {}
