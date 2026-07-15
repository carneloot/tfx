import { describe, expect, it } from 'vitest';

import * as InlineKeyboard from '../src/InlineKeyboard.js';
import * as ReplyKeyboard from '../src/ReplyKeyboard.js';

describe('keyboard builders', () => {
	it('builds immutable reply rows and options', () => {
		const keyboard = ReplyKeyboard.rows(
			[['Yes', ReplyKeyboard.webApp('Open', 'https://example.com')]],
			{
				isPersistent: true,
				resize: true,
				oneTime: true,
				placeholder: 'Choose',
				selective: true,
			},
		);
		expect(keyboard).toEqual({
			keyboard: [
				[
					{ text: 'Yes' },
					{ text: 'Open', web_app: { url: 'https://example.com' } },
				],
			],
			is_persistent: true,
			resize_keyboard: true,
			one_time_keyboard: true,
			input_field_placeholder: 'Choose',
			selective: true,
		});
		expect(Object.isFrozen(keyboard)).toBe(true);
		expect(Object.isFrozen(keyboard.keyboard[0])).toBe(true);
		expect(Object.isFrozen(keyboard.keyboard[0]![1]!.web_app)).toBe(true);
	});

	it('builds immutable callback, URL, and Web App rows', () => {
		const keyboard = InlineKeyboard.rows([
			[
				InlineKeyboard.callback('Pick', 'pet:rex'),
				InlineKeyboard.url('Site', 'https://example.com'),
				InlineKeyboard.webApp('App', 'https://example.com/app'),
			],
		]);
		expect(keyboard.inline_keyboard[0]).toEqual([
			{ text: 'Pick', callback_data: 'pet:rex' },
			{ text: 'Site', url: 'https://example.com' },
			{ text: 'App', web_app: { url: 'https://example.com/app' } },
		]);
		expect(Object.isFrozen(keyboard.inline_keyboard)).toBe(true);
		expect(Object.isFrozen(keyboard.inline_keyboard[0])).toBe(true);
	});
});
