import { Effect, Layer } from 'effect';
import * as ConversationsLive from 'tfx/Conversations';
import { ConversationStorage } from 'tfx/ConversationStorage';
import * as MemoryConversationStorage from 'tfx/MemoryConversationStorage';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { UpdateContext } from 'tfx/UpdateContext';
import { describe, expect, it } from 'vitest';

import { cancelCurrent } from '../src/bot/CancelConversation.js';

describe('cancel conversation handler', () => {
	it('deletes current row and requests reply-keyboard removal', async () => {
		const outputs: Array<{ text: string; options: unknown }> = [];
		const message = {
			reply: (text: string, options: unknown) =>
				Effect.sync(() => {
					outputs.push({ text, options });
					return {} as never;
				}),
		} as unknown as MessageContextService;
		const scope = { botId: 'carneloot', chatId: -100, userId: 42 };
		const program = Effect.gen(function* () {
			const storage = yield* ConversationStorage;
			yield* storage.create(
				{
					scope,
					conversationId: 'flow',
					version: 1,
					step: 'name',
					state: {},
					lastUpdateId: undefined,
					expiresAt: undefined,
				},
				'fail',
			);
			const cancelled = yield* cancelCurrent;
			return { cancelled, row: yield* storage.load(scope) };
		});
		const dependencies = Layer.mergeAll(
			MemoryConversationStorage.layer,
			Layer.succeed(MessageContext, message),
			Layer.succeed(UpdateContext, {
				update: { update_id: 1 } as never,
				updateId: 1,
				chatId: -100,
				userId: 42,
			}),
		);
		const executable = Effect.provide(
			Effect.provide(program, ConversationsLive.layer),
			dependencies,
		) as Effect.Effect<{ cancelled: boolean; row: unknown }, unknown>;
		const result = await Effect.runPromise(executable);
		expect(result).toEqual({ cancelled: true, row: undefined });
		expect(outputs).toEqual([
			{
				text: 'Conversa cancelada.',
				options: { reply_markup: { remove_keyboard: true } },
			},
		]);
	});
});
