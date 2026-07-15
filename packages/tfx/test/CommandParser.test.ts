import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import * as CommandInput from '../src/CommandInput.js';
import {
	matchCommand,
	parseCommand,
} from '../src/internal/bot/CommandParser.js';

const message = (
	text: string,
	type = 'bot_command',
	offset = 0,
	length = text.indexOf(' ') < 0 ? text.length : text.indexOf(' '),
) => ({
	text,
	entities: [{ type, offset, length }],
});

describe('CommandParser', () => {
	it('matches only an offset-zero Telegram bot_command entity', () => {
		expect(matchCommand(message('/add one'), 'add', 'MyBot')).toBe(' one');
		expect(matchCommand(message('/add@mybot one'), 'add', 'MyBot')).toBe(
			' one',
		);
		expect(
			matchCommand(message('/add@OtherBot one'), 'add', 'MyBot'),
		).toBeUndefined();
		expect(
			matchCommand(message('/add one', 'bold'), 'add', 'MyBot'),
		).toBeUndefined();
		expect(
			matchCommand(message('x/add', 'bot_command', 1, 4), 'add', 'MyBot'),
		).toBeUndefined();
	});

	it('rejects command input left after the declaration is consumed', async () => {
		await expect(
			Effect.runPromise(
				parseCommand(
					CommandInput.none,
					message('/start extra'),
					'start',
					'MyBot',
				),
			),
		).rejects.toMatchObject({ reason: 'UnexpectedInput' });
	});

	it('matches and parses in one effect', async () => {
		await expect(
			Effect.runPromise(
				parseCommand(CommandInput.none, message('/start'), 'start', 'MyBot'),
			),
		).resolves.toEqual({});
		await expect(
			Effect.runPromise(
				parseCommand(CommandInput.none, message('/other'), 'start', 'MyBot'),
			),
		).resolves.toBeUndefined();
	});
});
