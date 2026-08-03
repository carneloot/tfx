import * as Effect from 'effect/Effect';

import { CurrentUser } from '../bot/CurrentUser.js';
import { CaregiverAccessLost } from '../domain/caregivers/CaregiverError.js';
import type { RegisteredUser } from '../domain/User.js';
import type { CaregiverActor } from './CaregiverResult.js';

export const displayName = (registered: RegisteredUser): string =>
	[registered.profile.firstName, registered.profile.lastName]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(' ');

export const currentActor = Effect.fn('CaregiverAccess.currentActor')(
	(actor: CaregiverActor) =>
		Effect.gen(function* () {
			const current = yield* CurrentUser;
			if (current.user.id !== actor.actorId)
				return yield* Effect.fail(
					new CaregiverAccessLost({ message: 'Actor identity changed' }),
				);
			return current;
		}),
);
