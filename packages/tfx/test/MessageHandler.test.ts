import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';

import * as Bot from '../src/Bot.js';
import * as BotGroup from '../src/BotGroup.js';
import * as MessageHandler from '../src/MessageHandler.js';
import * as MessageHandlerResult from '../src/MessageHandlerResult.js';
import * as MessageInput from '../src/MessageInput.js';

const update = (message: unknown) => ({ update_id: 1, message }) as never;
describe('message handlers', () => {
	it('decodes ordinary text and reply identity only', async () => {
		const plain = MessageInput.text(Schema.String);
		const reply = MessageInput.replyText(Schema.String);
		expect(
			await Effect.runPromise(
				MessageInput.decode(plain, update({ text: 'hi' }))!,
			),
		).toBe('hi');
		expect(
			await Effect.runPromise(
				MessageInput.decode(
					reply,
					update({ text: 'hi', reply_to_message: { message_id: 42 } }),
				)!,
			),
		).toEqual({ text: 'hi', repliedMessageId: 42 });
		expect(MessageInput.decode(reply, update({ text: 'hi' }))).toBeUndefined();
		expect(
			MessageInput.decode(plain, {
				update_id: 1,
				edited_message: { text: 'hi' },
			} as never),
		).toBeUndefined();
	});
	it('keeps command and message id namespaces distinct and declarations immutable', () => {
		const declaration = MessageHandler.make('same', {
			input: MessageInput.text(Schema.String),
			error: Schema.Void,
		});
		const group = BotGroup.make('mixed').addMessage(declaration);
		expect(group.messageHandlers.same).toBe(declaration);
		expect(Object.isFrozen(group.messageHandlers)).toBe(true);
		expect(() => group.addMessage(declaration as never)).toThrow(
			/Duplicate message handler/,
		);
		expect(() =>
			Bot.make('bot')
				.add(group)
				.add(BotGroup.make('other').addMessage(declaration)),
		).toThrow(/Duplicate message handler/);
		expect(MessageHandlerResult.handled._tag).toBe('Handled');
	});
});
