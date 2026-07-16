import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { migrate } from './AppMigrator.js';
import * as NotificationRecipientsLive from './NotificationRecipientsLive.js';
import * as NotificationRepositoryLive from './NotificationRepositoryLive.js';
import * as PetFoodRepositoryLive from './PetFoodRepositoryLive.js';
import * as PetRepositoryLive from './PetRepositoryLive.js';
import * as UserRepositoryLive from './UserRepositoryLive.js';

export const layer = Layer.unwrap(
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
);
