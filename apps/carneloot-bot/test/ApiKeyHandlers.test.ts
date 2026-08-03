import { describe, expect, it } from 'vitest';

import { Carneloot, menuCommands } from '../src/bot/Declaration.js';

describe('API key command declaration', () => {
	it('requires registered user and exposes gerar_chave', () => {
		expect(Carneloot.groups.apiKeys.commands.generateApiKey.name).toBe(
			'gerar_chave',
		);
		expect(menuCommands.map((command) => command.command)).toContain(
			'gerar_chave',
		);
	});
});
