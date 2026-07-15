import { Bot, BotGroup, Command, MessageContext, Middleware } from 'tfx';

import { ApplicationError } from '../domain/ApplicationError.js';
import { CurrentUser } from './CurrentUser.js';

export const RegisteredUser = Middleware.make('registered-user', {
	scope: 'global',
	requires: [MessageContext.MessageContext],
	provides: CurrentUser,
	error: ApplicationError,
});
export const account = BotGroup.make('account').add(
	Command.make('register', {
		name: 'cadastrar',
		error: ApplicationError,
	}),
);
export const pets = BotGroup.make('pets')
	.add(
		Command.make('addPet', {
			name: 'adicionar_pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('listPets', {
			name: 'listar_pets',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	);
export const petFood = BotGroup.make('petFood')
	.add(
		Command.make('configureDayStart', {
			name: 'configurar_inicio_dia',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('configureReminderDelay', {
			name: 'configurar_atraso_notificacao',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('foodStatus', {
			name: 'status_racao',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('addFood', {
			name: 'colocar_racao',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	);
export const Carneloot = Bot.make('carneloot')
	.add(account)
	.add(pets)
	.add(petFood);
export const botId = Carneloot.name;
