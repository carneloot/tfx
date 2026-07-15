import type { Update } from './internal/telegram/generated/TelegramApi.types.js';
export type UpdateRoutingScope =
	| {
			readonly _tag: 'ChatUser';
			readonly botId: string;
			readonly chatId: number;
			readonly userId: number;
			readonly updateId: number;
	  }
	| {
			readonly _tag: 'Chat';
			readonly botId: string;
			readonly chatId: number;
			readonly updateId: number;
	  }
	| {
			readonly _tag: 'User';
			readonly botId: string;
			readonly userId: number;
			readonly updateId: number;
	  }
	| {
			readonly _tag: 'BusinessConnection';
			readonly botId: string;
			readonly businessConnectionId: string;
			readonly updateId: number;
	  }
	| {
			readonly _tag: 'Update';
			readonly botId: string;
			readonly updateId: number;
	  };
type RecordValue = Readonly<Record<string, any>>;
const record = (value: unknown): RecordValue | undefined =>
	typeof value === 'object' && value !== null
		? (value as RecordValue)
		: undefined;
export const fromUpdate = (
	botId: string,
	update: Update,
): UpdateRoutingScope => {
	const root = update as unknown as RecordValue;
	const event = Object.entries(root).find(
		([key, value]) => key !== 'update_id' && record(value) !== undefined,
	)?.[1] as unknown;
	const item = record(event);
	const callbackMessage = record(record(root.callback_query)?.message);
	const message =
		record(root.message) ??
		record(root.edited_message) ??
		record(root.channel_post) ??
		record(root.edited_channel_post) ??
		record(root.business_message) ??
		record(root.edited_business_message) ??
		callbackMessage;
	const chat = record(message?.chat) ?? record(item?.chat);
	const user =
		record(item?.from) ?? record(item?.user) ?? record(message?.from);
	const chatId = typeof chat?.id === 'number' ? chat.id : undefined;
	const userId = typeof user?.id === 'number' ? user.id : undefined;
	const base = { botId, updateId: update.update_id };
	if (chatId !== undefined && userId !== undefined)
		return { _tag: 'ChatUser', ...base, chatId, userId };
	if (chatId !== undefined) return { _tag: 'Chat', ...base, chatId };
	if (userId !== undefined) return { _tag: 'User', ...base, userId };
	const businessConnectionId =
		typeof item?.id === 'string' && root.business_connection === event
			? item.id
			: typeof item?.business_connection_id === 'string'
				? item.business_connection_id
				: undefined;
	return businessConnectionId === undefined
		? { _tag: 'Update', ...base }
		: { _tag: 'BusinessConnection', ...base, businessConnectionId };
};
export const conversationScope = (scope: UpdateRoutingScope) =>
	scope._tag === 'ChatUser'
		? { botId: scope.botId, chatId: scope.chatId, userId: scope.userId }
		: undefined;
