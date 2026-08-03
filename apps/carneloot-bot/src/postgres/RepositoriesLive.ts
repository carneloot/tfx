import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import * as ApiKeyRepositoryLive from './ApiKeyRepositoryLive.js';
import { migrate } from './AppMigrator.js';
import * as NotificationRecipientsLive from './NotificationRecipientsLive.js';
import * as NotificationRepositoryLive from './NotificationRepositoryLive.js';
import * as NotificationTemplateRepositoryLive from './NotificationTemplateRepositoryLive.js';
import * as PetCaregiverRepositoryLive from './PetCaregiverRepositoryLive.js';
import * as PetFoodRepositoryLive from './PetFoodRepositoryLive.js';
import * as PetRepositoryLive from './PetRepositoryLive.js';
import * as UserRepositoryLive from './UserRepositoryLive.js';

export const layer = Layer.unwrap(
	Effect.as(
		migrate,
		Layer.mergeAll(
			UserRepositoryLive.layer,
			ApiKeyRepositoryLive.layer,
			PetRepositoryLive.layer,
			PetCaregiverRepositoryLive.layer,
			PetFoodRepositoryLive.layer,
			NotificationRepositoryLive.layer,
			NotificationRecipientsLive.layer,
			NotificationTemplateRepositoryLive.layer,
		),
	),
);
