import { Bot, BotGroup, Command, Middleware } from 'tfx';

import { CurrentUser } from './CurrentUser.js';

export const RegisteredUser = Middleware.make('registered-user', {
	scope: 'global',
	provides: CurrentUser,
	error: undefined as unknown,
});
export const account = BotGroup.make('account').add(
	Command.make('register', { name: 'cadastrar', error: undefined as unknown }),
);
export const pets = BotGroup.make('pets')
	.add(
		Command.make('addPet', {
			name: 'adicionar_pet',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	)
	.add(
		Command.make('listPets', {
			name: 'listar_pets',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	);
export const Carneloot = Bot.make('carneloot').add(account).add(pets);
export const botId = Carneloot.name;
