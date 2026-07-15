import * as Context from 'effect/Context';

import type { Update } from './internal/telegram/generated/TelegramApi.types.js';

export interface UpdateContextService {
	readonly update: Update;
	readonly updateId: number;
	readonly userId: number | undefined;
	readonly chatId: number | undefined;
}

export class UpdateContext extends Context.Service<
	UpdateContext,
	UpdateContextService
>()('tfx/UpdateContext') {}

type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): RecordValue | undefined =>
	typeof value === 'object' && value !== null
		? (value as RecordValue)
		: undefined;

export const make = (update: Update): UpdateContextService => {
	const root = update as unknown as RecordValue;
	const event = Object.values(root).find(
		(value) => record(value) !== undefined,
	) as unknown;
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
	const user =
		record(item?.from) ?? record(item?.user) ?? record(message?.from);
	const chat = record(message?.chat) ?? record(item?.chat);
	return Object.freeze({
		update,
		updateId: update.update_id,
		userId: typeof user?.id === 'number' ? user.id : undefined,
		chatId: typeof chat?.id === 'number' ? chat.id : undefined,
	});
};
