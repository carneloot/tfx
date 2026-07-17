import { describe, expect, it } from 'vitest';

import * as Production from '../src/Production.js';
import * as Router from '../src/Router.js';
import { testConfig } from './internal/TestConfig.js';

describe('portable Node composition', () => {
	it('exports complete router metadata and production polling options', () => {
		expect(Router.accountHandlers.entries).toHaveLength(1);
		expect(Router.petHandlers.entries).toHaveLength(8);
		expect(Router.petFoodHandlers.entries).toHaveLength(4);
		expect(Router.conversations).toHaveLength(10);
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
			{ command: 'parar_de_cuidar_pet', description: 'Parar de cuidar de um pet' },
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
		]);
		expect(polling.languageCode).toBe('pt');
		expect(polling.allowedUpdates).toContain('callback_query');
		expect(polling.allowedUpdates).toContain('message_reaction');
	});
});
