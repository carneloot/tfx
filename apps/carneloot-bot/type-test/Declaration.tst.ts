import { Effect } from 'effect';
import { BotBuilder } from 'tfx';

import { CurrentUser } from '../src/bot/CurrentUser.js';
import { Carneloot } from '../src/bot/Declaration.js';

BotBuilder.group(Carneloot, 'account', (handlers) =>
	handlers.handle('register', () => Effect.void),
);
BotBuilder.group(
	Carneloot,
	'pets',
	// @ts-expect-error pets group must implement listPets too
	(handlers) => handlers.handle('addPet', () => Effect.void),
);
BotBuilder.group(Carneloot, 'pets', (handlers) =>
	handlers
		.handle('addPet', () => Effect.map(CurrentUser, () => undefined))
		.handle('listPets', () => Effect.map(CurrentUser, () => undefined)),
);
