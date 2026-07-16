import type * as DateTime from 'effect/DateTime';

import type { BotId, TelegramChatId, TelegramUserId, UserId } from './Ids.js';
export interface User {
	readonly id: UserId;
	readonly createdAt: DateTime.Utc;
	readonly updatedAt: DateTime.Utc;
}
export interface TelegramProfile {
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly username: string | null;
	readonly firstName: string;
	readonly lastName: string | null;
	readonly privateChatId: TelegramChatId;
}
export interface RegisteredUser {
	readonly user: User;
	readonly profile: TelegramProfile;
}
