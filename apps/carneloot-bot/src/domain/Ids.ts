import * as Schema from 'effect/Schema';

import { Uuid } from './Uuid.js';

export const UserId = Uuid.pipe(Schema.brand('CarnelootUserId'));
export type UserId = typeof UserId.Type;
export const PetId = Uuid.pipe(Schema.brand('CarnelootPetId'));
export type PetId = typeof PetId.Type;
export const BotId = Schema.NonEmptyString.pipe(Schema.brand('CarnelootBotId'));
export type BotId = typeof BotId.Type;
export const TelegramUserId = Schema.Number.check(
	Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0),
).pipe(Schema.brand('TelegramUserId'));
export type TelegramUserId = typeof TelegramUserId.Type;
export const TelegramChatId = Schema.Number.check(
	Schema.makeFilter((value) => Number.isSafeInteger(value) && value !== 0),
).pipe(Schema.brand('TelegramChatId'));
export type TelegramChatId = typeof TelegramChatId.Type;
