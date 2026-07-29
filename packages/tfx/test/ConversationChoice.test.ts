import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as CallbackData from '../src/CallbackData.js';
import * as ConversationChoice from '../src/ConversationChoice.js';
import * as ConversationPrompt from '../src/ConversationPrompt.js';

describe('ConversationChoice', () => {
	it('rejects empty and duplicate reply choices before rendering', () => {
		expect(() => ConversationChoice.make([])).toThrow('cannot be empty');
		expect(() =>
			ConversationChoice.make([
				{ label: 'A', value: 1 },
				{ label: 'A', value: 2 },
			]),
		).toThrow('Duplicate');
	});
	it('renders immutable reply rows and resolves selected/cancelled', async () => {
		const choice = ConversationChoice.reply(
			[
				{ label: 'A', value: 1 },
				{ label: 'B', value: 2 },
			],
			{ columns: 2, cancelLabel: 'Cancelar' },
		);
		const markup = await Effect.runPromise(ConversationPrompt.choice(choice));
		expect(markup).toMatchObject({
			keyboard: [[{ text: 'A' }, { text: 'B' }], [{ text: 'Cancelar' }]],
			one_time_keyboard: true,
			resize_keyboard: true,
		});
		expect(Object.isFrozen(markup)).toBe(true);
		await expect(
			Effect.runPromise(ConversationPrompt.resolve(choice, 'A')),
		).resolves.toEqual({ _tag: 'Selected', value: 1 });
		await expect(
			Effect.runPromise(ConversationPrompt.resolve(choice, 'Cancelar')),
		).resolves.toEqual({ _tag: 'Cancelled' });
	});
	it('renders boolean replies in two columns', async () => {
		const confirmation = ConversationChoice.boolean({ yes: 'Sim', no: 'Não' });
		expect(
			await Effect.runPromise(ConversationPrompt.choice(confirmation)),
		).toMatchObject({
			keyboard: [[{ text: 'Sim' }, { text: 'Não' }]],
		});
	});
	it('rejects duplicate encoded callback values', async () => {
		const codec = CallbackData.make('choice', Schema.String);
		const choice = ConversationChoice.make(
			[
				{ label: 'A', value: 'same' },
				{ label: 'B', value: 'same' },
			],
			{ callbackData: codec },
		);
		await expect(
			Effect.runPromise(
				ConversationPrompt.choice(choice) as Effect.Effect<unknown, unknown>,
			),
		).rejects.toMatchObject({ reason: 'DuplicateValue' });
		let acknowledged = false;
		await expect(
			Effect.runPromise(
				ConversationPrompt.resolve(choice, 'choice:same', {
					acknowledge: Effect.sync(() => {
						acknowledged = true;
					}),
				}) as Effect.Effect<unknown, unknown>,
			),
		).resolves.toEqual({ _tag: 'Selected', value: 'same' });
		expect(acknowledged).toBe(true);
	});
	it('exposes reply keyboard removal', () =>
		expect(ConversationPrompt.removeReplyKeyboard).toEqual({
			remove_keyboard: true,
		}));
});
