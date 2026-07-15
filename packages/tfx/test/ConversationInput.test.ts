import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as CallbackData from '../src/CallbackData.js';
import * as CommandInput from '../src/CommandInput.js';
import * as ConversationChoice from '../src/ConversationChoice.js';
import * as ConversationInput from '../src/ConversationInput.js';

describe('ConversationInput', () => {
	it('decodes text, callback, choice, command, and reaction inputs', async () => {
		const callback = CallbackData.make('pick', Schema.NumberFromString);
		const choice = ConversationChoice.make([
			{ label: 'One', value: 1 },
			{ label: 'Two', value: 2 },
		]);
		await expect(
			Effect.runPromise(
				Effect.all([
					ConversationInput.decode(
						ConversationInput.text(Schema.NumberFromString),
						'3',
					),
					ConversationInput.decode(
						ConversationInput.callback(callback),
						'pick:4',
					),
					ConversationInput.decode(ConversationInput.choice(choice), 'Two'),
					ConversationInput.decode(
						ConversationInput.command(
							CommandInput.argument('amount', Schema.NumberFromString),
						),
						'5',
					),
					ConversationInput.decode(ConversationInput.reaction, [
						{ type: 'emoji', emoji: '👍' },
					]),
				]),
			),
		).resolves.toEqual([
			3,
			4,
			{ _tag: 'Selected', value: 2 },
			{ amount: 5 },
			[{ type: 'emoji', emoji: '👍' }],
		]);
	});

	it('rejects malformed raw values before handlers run', async () => {
		await expect(
			Effect.runPromise(
				ConversationInput.decode(
					ConversationInput.text(Schema.NumberFromString),
					5,
				),
			),
		).rejects.toBeDefined();
		await expect(
			Effect.runPromise(
				ConversationInput.decode(ConversationInput.reaction, [{ emoji: '👍' }]),
			),
		).rejects.toBeInstanceOf(TypeError);
	});
});
