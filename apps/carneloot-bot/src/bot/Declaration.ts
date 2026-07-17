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
		description: 'Cadastrar ou atualizar seu perfil',
		error: ApplicationError,
	}),
);
export const pets = BotGroup.make('pets')
	.add(
		Command.make('addPet', {
			name: 'adicionar_pet',
			description: 'Adicionar um pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('listPets', {
			name: 'listar_pets',
			description: 'Listar seus pets',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('deletePet', {
			name: 'deletar_pet',
			description: 'Deletar um pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('inviteCaregiver', {
			name: 'adicionar_cuidador',
			description: 'Convidar cuidador',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('removeCaregiver', {
			name: 'remover_cuidador',
			description: 'Remover cuidador',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('listCaregivers', {
			name: 'listar_cuidadores',
			description: 'Listar cuidadores',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('petInvitations', {
			name: 'convites_pet',
			description: 'Responder convites de pets',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('stopCaring', {
			name: 'parar_de_cuidar_pet',
			description: 'Parar de cuidar de um pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	);
export const petFood = BotGroup.make('petFood')
	.add(
		Command.make('configureDayStart', {
			name: 'configurar_inicio_dia',
			description: 'Configurar início do dia do pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('configureReminderDelay', {
			name: 'configurar_atraso_notificacao',
			description: 'Configurar atraso das notificações',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('foodStatus', {
			name: 'status_racao',
			description: 'Consultar o status de ração',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('addFood', {
			name: 'colocar_racao',
			description: 'Registrar ração para um pet',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	);
export const Carneloot = Bot.make('carneloot')
	.add(account)
	.add(pets)
	.add(petFood);
export const menuCommands = Bot.commandMenu(Carneloot);
export const botId = Carneloot.name;
