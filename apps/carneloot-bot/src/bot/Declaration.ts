import * as Schema from 'effect/Schema';
import {
	Bot,
	BotGroup,
	Command,
	CommandInput,
	MessageContext,
	MessageHandler,
	MessageInput,
	Middleware,
} from 'tfx';

import { ApplicationError } from '../domain/ApplicationError.js';
import { FoodAmount } from '../domain/pet-food/FoodAmount.js';
import { FoodWhenInput } from '../domain/pet-food/FoodWhenInput.js';
import { CurrentUser } from './CurrentUser.js';
import * as ForwardToOwner from './ForwardToOwner.js';

export const RegisteredUser = Middleware.make('registered-user', {
	scope: 'global',
	requires: [MessageContext.MessageContext],
	provides: CurrentUser,
	error: ApplicationError,
});
const generalInput = CommandInput.optional(
	CommandInput.rest('input', Schema.String),
);
export const general = BotGroup.make('general')
	.add(
		Command.make('start', {
			name: 'start',
			description: 'Iniciar o bot',
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('cancel', {
			name: 'cancelar',
			description: 'Cancelar a operação atual',
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('ping', {
			name: 'ping',
			description: 'Verificar resposta, com atraso opcional em ms',
			input: generalInput,
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('whats', {
			name: 'whats',
			description: 'Criar link do WhatsApp com mensagem opcional',
			input: generalInput,
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('cafe', {
			name: 'cafe',
			description: 'Calcular café V60 pela quantidade de água',
			input: generalInput,
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('cafeInv', {
			name: 'cafe_inv',
			description: 'Calcular água para V60 pela quantidade de café',
			input: generalInput,
			error: ApplicationError,
		}),
	)
	.addMessage(
		MessageHandler.make('hello', {
			input: MessageInput.text(Schema.String),
			error: ApplicationError,
		}),
	);

export const account = BotGroup.make('account')
	.add(
		Command.make('register', {
			name: 'cadastrar',
			description: 'Cadastrar ou atualizar seu perfil',
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('generateApiKey', {
			name: 'gerar_chave',
			description: 'Gerar chave para notificações externas',
			middleware: [RegisteredUser],
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
export const AddFoodToAllInput = CommandInput.sequence(
	CommandInput.argument('amount', FoodAmount),
	CommandInput.optional(CommandInput.rest('when', FoodWhenInput)),
);

export const addFoodToAll = Command.make('addFoodToAll', {
	name: 'colocar_racao_todos',
	aliases: ['todos'],
	description: 'Registrar ração para todos os pets',
	input: AddFoodToAllInput,
	middleware: [RegisteredUser],
	error: ApplicationError,
});

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
	)
	.add(
		Command.make('correctFood', {
			name: 'corrigir_racao',
			description: 'Corrigir um registro de ração',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(
		Command.make('deleteFood', {
			name: 'deletar_racao',
			description: 'Deletar um registro de ração',
			middleware: [RegisteredUser],
			error: ApplicationError,
		}),
	)
	.add(addFoodToAll);

export const replies = BotGroup.make('replies')
	.addMessage(
		MessageHandler.make('externalNotificationReply', {
			input: MessageInput.replyText(Schema.String),
			error: ApplicationError,
		}),
	)
	.addMessage(
		MessageHandler.make('foodReply', {
			input: MessageInput.replyText(Schema.String),
			error: ApplicationError,
		}),
	);

export const Carneloot = Bot.make('carneloot')
	.add(account)
	.add(pets)
	.add(petFood)
	.add(replies)
	.add(ForwardToOwner.group)
	.add(general);
export const menuCommands = Bot.commandMenu(Carneloot);
export const botId = Carneloot.name;
