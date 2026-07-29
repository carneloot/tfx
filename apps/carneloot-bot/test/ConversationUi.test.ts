import { Effect } from 'effect';
import { ConversationChoice } from 'tfx';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { describe, expect, it } from 'vitest';

import * as ConversationUi from '../src/bot/conversations/ConversationUi.js';

const recordedContext = (outputs: Array<{ text: string; options: unknown }>) =>
	({
		reply: (text: string, options: unknown) =>
			Effect.sync(() => {
				outputs.push({ text, options });
				return {} as never;
			}),
	}) as unknown as MessageContextService;

const withContext = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	context: MessageContextService,
) =>
	Effect.provideService(
		effect as Effect.Effect<A, E, MessageContext>,
		MessageContext,
		context,
	) as Effect.Effect<A, E>;

describe('ConversationUi', () => {
	it('renders choice prompts and removes keyboards for text prompts', async () => {
		const outputs: Array<{ text: string; options: unknown }> = [];
		const context = recordedContext(outputs);
		const choice = ConversationChoice.reply(
			[
				{ label: 'A', value: 1 },
				{ label: 'B', value: 2 },
			],
			{ columns: 2, cancelLabel: 'Cancelar' },
		);

		await Effect.runPromise(
			withContext(ConversationUi.promptChoice('Escolha:', choice), context),
		);
		await Effect.runPromise(
			withContext(ConversationUi.replyRemovingKeyboard('Digite:'), context),
		);

		expect(outputs).toEqual([
			{
				text: 'Escolha:',
				options: {
					reply_markup: {
						keyboard: [[{ text: 'A' }, { text: 'B' }], [{ text: 'Cancelar' }]],
						one_time_keyboard: true,
						resize_keyboard: true,
					},
				},
			},
			{
				text: 'Digite:',
				options: { reply_markup: { remove_keyboard: true } },
			},
		]);
	});

	it('replies without markup and preserves Telegram failures', async () => {
		const outputs: Array<{ text: string; options: unknown }> = [];
		await Effect.runPromise(
			withContext(ConversationUi.reply('texto'), recordedContext(outputs)),
		);
		expect(outputs).toEqual([{ text: 'texto', options: undefined }]);

		const failure = new Error('Telegram unavailable');
		const failedContext = {
			reply: () => Effect.fail(failure),
		} as unknown as MessageContextService;
		const result = await Effect.runPromise(
			Effect.result(withContext(ConversationUi.reply('texto'), failedContext)),
		);
		expect(result).toMatchObject({ _tag: 'Failure', failure });
	});

	it('makes reply labels globally unique without shadowing cancellation', () => {
		expect(
			ConversationUi.uniqueReplyOptions([
				{ label: 'Rex', value: 1 },
				{ label: 'Rex', value: 2 },
				{ label: 'Rex (1)', value: 3 },
			]),
		).toEqual([
			{ label: 'Rex (1)', value: 1 },
			{ label: 'Rex (2)', value: 2 },
			{ label: 'Rex (1) (1)', value: 3 },
		]);
		expect(
			ConversationUi.uniqueReplyOptions([
				{ label: 'Cancelar', value: 1 },
				{ label: 'Cancelar (1)', value: 2 },
			]),
		).toEqual([
			{ label: 'Cancelar (1)', value: 1 },
			{ label: 'Cancelar (1) (1)', value: 2 },
		]);
	});
});
