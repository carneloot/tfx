import { Context, Effect } from 'effect';
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
		.handle('listPets', () => Effect.map(CurrentUser, () => undefined)),
);
class Audit extends Context.Service<Audit, { readonly id: string }>()(
	'types/Audit',
) {}
const requiresRegistration = Middleware.make('requires-registration', {
	scope: 'command',
	provides: Audit,
	requires: [CurrentUser],
});
Command.make('invalid-unregistered', {
	name: 'invalid_unregistered',
	// @ts-expect-error CurrentUser requirement is unavailable without registration middleware
	middleware: [requiresRegistration],
});
