import type { BotId, TelegramChatId, TelegramUserId, UserId } from '../domain/Ids.js';

export interface PrivateNotice {
	readonly chatId: TelegramChatId;
	readonly text: string;
}
export interface MutationResult<A> {
	readonly value: A;
	readonly notices: ReadonlyArray<PrivateNotice>;
}
export interface CaregiverActor {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
}
