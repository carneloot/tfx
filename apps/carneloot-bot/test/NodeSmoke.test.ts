import { describe, expect, it } from 'vitest';

import * as Production from '../src/Production.js';
import * as Router from '../src/Router.js';
import { testConfig } from './internal/TestConfig.js';

describe('portable Node composition', () => {
	it('exports complete router metadata and production polling options', () => {
		expect(
			[
				Router.accountHandlers,
				Router.petHandlers,
				Router.petFoodHandlers,
				Router.replyHandlers,
			].map((group) => ({
				groupId: group.groupId,
				entries: group.entries.map((entry) =>
					entry._tag === 'Command'
						? `${entry._tag}:${entry.commandId}`
						: `${entry._tag}:${entry.messageHandlerId}`,
				),
			})),
		).toEqual([
			{ groupId: 'account', entries: ['Command:register'] },
			{
				groupId: 'pets',
				entries: [
					'Command:addPet',
					'Command:listPets',
					'Command:deletePet',
					'Command:inviteCaregiver',
					'Command:removeCaregiver',
					'Command:listCaregivers',
					'Command:petInvitations',
					'Command:stopCaring',
				],
			},
			{
				groupId: 'petFood',
				entries: [
					'Command:configureDayStart',
					'Command:configureReminderDelay',
					'Command:foodStatus',
					'Command:addFood',
					'Command:correctFood',
					'Command:deleteFood',
					'Command:addFoodToAll',
				],
			},
			{ groupId: 'replies', entries: ['Message:foodReply'] },
		]);
		expect(Router.conversations.map((built) => built.declaration.id)).toEqual([
			'add-owned-pet',
			'configure-pet-day-start',
			'configure-reminder-delay',
			'add-pet-food',
			'correct-pet-food',
			'delete-pet-food',
			'delete-pet',
			'invite-pet-caregiver',
			'remove-pet-caregiver',
			'list-pet-caregivers',
			'pet-caregiver-invitations',
			'stop-caring-for-pet',
		]);
		const polling = Production.pollingOptions(testConfig);
		expect(polling.commands).toEqual([
			{
				command: 'cadastrar',
				description: 'Cadastrar ou atualizar seu perfil',
			},
			{ command: 'adicionar_pet', description: 'Adicionar um pet' },
			{ command: 'listar_pets', description: 'Listar seus pets' },
			{ command: 'deletar_pet', description: 'Deletar um pet' },
			{ command: 'adicionar_cuidador', description: 'Convidar cuidador' },
			{ command: 'remover_cuidador', description: 'Remover cuidador' },
			{ command: 'listar_cuidadores', description: 'Listar cuidadores' },
			{ command: 'convites_pet', description: 'Responder convites de pets' },
			{
				command: 'parar_de_cuidar_pet',
				description: 'Parar de cuidar de um pet',
			},
			{
				command: 'configurar_inicio_dia',
				description: 'Configurar início do dia do pet',
			},
			{
				command: 'configurar_atraso_notificacao',
				description: 'Configurar atraso das notificações',
			},
			{ command: 'status_racao', description: 'Consultar o status de ração' },
			{ command: 'colocar_racao', description: 'Registrar ração para um pet' },
			{
				command: 'corrigir_racao',
				description: 'Corrigir um registro de ração',
			},
			{
				command: 'deletar_racao',
				description: 'Deletar um registro de ração',
			},
			{
				command: 'colocar_racao_todos',
				description: 'Registrar ração para todos os pets',
			},
			{
				command: 'todos',
				description: 'Registrar ração para todos os pets',
			},
		]);
		expect(polling.languageCode).toBe('pt');
		expect(polling.allowedUpdates).toContain('callback_query');
		expect(polling.allowedUpdates).toContain('message_reaction');
	});
});
