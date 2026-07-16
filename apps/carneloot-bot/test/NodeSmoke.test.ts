import { describe, expect, it } from 'vitest';

import * as Production from '../src/Production.js';
import * as Router from '../src/Router.js';
import { testConfig } from './internal/TestConfig.js';

describe('portable Node composition', () => {
	it('exports complete router metadata and production polling options', () => {
		expect(Router.accountHandlers.entries).toHaveLength(1);
		expect(Router.petHandlers.entries).toHaveLength(2);
		expect(Router.petFoodHandlers.entries).toHaveLength(4);
		expect(Router.conversations).toHaveLength(4);
		const polling = Production.pollingOptions(testConfig);
		expect(polling.commands).toEqual([
			{
				command: 'cadastrar',
				description: 'Cadastrar ou atualizar seu perfil',
			},
			{ command: 'adicionar_pet', description: 'Adicionar um pet' },
			{ command: 'listar_pets', description: 'Listar seus pets' },
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
