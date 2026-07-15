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
export const petFood = BotGroup.make('petFood')
	.add(
		Command.make('configureDayStart', {
			name: 'configurar_inicio_dia',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	)
	.add(
		Command.make('configureReminderDelay', {
			name: 'configurar_atraso_notificacao',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	)
	.add(
		Command.make('foodStatus', {
			name: 'status_racao',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	)
	.add(
		Command.make('addFood', {
			name: 'colocar_racao',
			middleware: [RegisteredUser],
			error: undefined as unknown,
		}),
	);
export const Carneloot = Bot.make('carneloot')
	.add(account)
	.add(pets)
	.add(petFood);
export const botId = Carneloot.name;
