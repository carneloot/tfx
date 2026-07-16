import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { DeliveryId } from '../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../src/domain/notifications/NotificationEvent.js';
import { FoodEntryId } from '../src/domain/pet-food/PetFood.js';
const user = Schema.decodeUnknownSync(TelegramUserId);
const chat = Schema.decodeUnknownSync(TelegramChatId);
const validUuid = '00000000-0000-4000-8000-000000000001';
const uuidDecoders: ReadonlyArray<(value: unknown) => string> = [
	Schema.decodeUnknownSync(UserId),
	Schema.decodeUnknownSync(PetId),
	Schema.decodeUnknownSync(FoodEntryId),
	Schema.decodeUnknownSync(EventId),
	Schema.decodeUnknownSync(DeliveryId),
];
describe('Telegram identifiers', () => {
	it('accepts RFC UUIDs and rejects malformed or sentinel identifiers', () => {
		for (const decode of uuidDecoders) {
			expect(decode(validUuid)).toBe(validUuid);
			for (const invalid of [
				'not-a-uuid',
				'00000000-0000-0000-0000-000000000000',
				'ffffffff-ffff-ffff-ffff-ffffffffffff',
			])
				expect(() => decode(invalid)).toThrow();
		}
	});
	it('accepts positive safe user IDs only', () => {
		expect(user(1)).toBe(1);
		expect(user(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		for (const value of [
			0,
			-1,
			Number.MAX_SAFE_INTEGER + 1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		])
			expect(() => user(value)).toThrow();
	});
	it('accepts signed nonzero safe chat IDs', () => {
		expect(chat(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
		expect(chat(-100123)).toBe(-100123);
		expect(chat(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		for (const value of [
			0,
			Number.MIN_SAFE_INTEGER - 1,
			Number.MAX_SAFE_INTEGER + 1,
			1.5,
			Number.NaN,
			Number.NEGATIVE_INFINITY,
		])
			expect(() => chat(value)).toThrow();
	});
});
