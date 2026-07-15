import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import * as ConfigureReminderDelay from '../../src/application/ConfigureReminderDelay.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../src/domain/Ids.js';

const access = {
	ownerId: Schema.decodeUnknownSync(UserId)(
		'00000000-0000-4000-8000-000000000001',
	),
	petId: Schema.decodeUnknownSync(PetId)(
		'00000000-0000-4000-8000-000000000002',
	),
	botId: Schema.decodeUnknownSync(BotId)('bot'),
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
};
describe('pet food application validation', () => {
	it('rejects delay outside one millisecond through thirty days before SQL', async () => {
		for (const delay of [0, 2_592_000_001]) {
			const result = await Effect.runPromise(
				Effect.result(
					ConfigureReminderDelay.set(access, delay),
				) as Effect.Effect<any>,
			);
			expect(result._tag).toBe('Failure');
		}
	});
	it('rejects unsafe update id before SQL', async () => {
		const source = await Effect.runPromise(
			Effect.result(
				AddFood.execute(access, '10g', '10:00', {
					botId: 'bot',
					updateId: Number.MAX_SAFE_INTEGER + 1,
				}),
			) as Effect.Effect<any>,
		);
		expect(source._tag).toBe('Failure');
	});
});
