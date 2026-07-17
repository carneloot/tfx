import { Context, Effect, Schema } from 'effect';
import { BotBuilder, Command, Middleware } from 'tfx';

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
		.handle('listPets', () => Effect.map(CurrentUser, () => undefined))
		.handle('deletePet', () => Effect.map(CurrentUser, () => undefined))
		.handle('inviteCaregiver', () => Effect.map(CurrentUser, () => undefined))
		.handle('removeCaregiver', () => Effect.map(CurrentUser, () => undefined))
		.handle('listCaregivers', () => Effect.map(CurrentUser, () => undefined))
		.handle('petInvitations', () => Effect.map(CurrentUser, () => undefined))
		.handle('stopCaring', () => Effect.map(CurrentUser, () => undefined)),
);
BotBuilder.group(Carneloot, 'petFood', (handlers) =>
	handlers
		.handle('configureDayStart', () => Effect.map(CurrentUser, () => undefined))
		.handle('configureReminderDelay', () =>
			Effect.map(CurrentUser, () => undefined),
		)
		.handle('foodStatus', () => Effect.map(CurrentUser, () => undefined))
		.handle('addFood', () => Effect.map(CurrentUser, () => undefined))
		.handle('correctFood', () => Effect.map(CurrentUser, () => undefined))
		.handle('deleteFood', () => Effect.map(CurrentUser, () => undefined))
		.handle('addFoodToAll', () => Effect.map(CurrentUser, () => undefined)),
);
class Audit extends Context.Service<Audit, { readonly id: string }>()(
	'types/Audit',
) {}
const requiresRegistration = Middleware.make('requires-registration', {
	scope: 'command',
	provides: Audit,
	requires: [CurrentUser],
	error: Schema.Void,
});
Command.make('invalid-unregistered', {
	name: 'invalid_unregistered',
	error: Schema.Void,
	// @ts-expect-error CurrentUser requirement is unavailable without registration middleware
	middleware: [requiresRegistration],
});
