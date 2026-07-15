import * as Schema from 'effect/Schema';

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const UserId = Schema.String.check(Schema.isPattern(uuidPattern)).pipe(
	Schema.brand('CarnelootUserId'),
);
export type UserId = typeof UserId.Type;
export const PetId = Schema.String.check(Schema.isPattern(uuidPattern)).pipe(
	Schema.brand('CarnelootPetId'),
);
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
