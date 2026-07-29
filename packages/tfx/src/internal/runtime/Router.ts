import * as Effect from 'effect/Effect';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
export type Route =
	| 'lifecycle'
	| 'beforeConversation'
	| 'conversation'
	| 'command'
	| 'callback'
	| 'message'
	| 'fallback';
export interface Router {
	readonly route: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
}
export interface RouterOptions {
	readonly lifecycle?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
	readonly beforeConversation?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome | undefined, never>;
	readonly conversation?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome | undefined, never>;
	readonly command?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome | undefined, never>;
	readonly callback?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
	readonly message?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome | undefined, never>;
	readonly fallback?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
}
type RecordValue = Readonly<Record<string, any>>;
const root = (update: Update) => update as unknown as RecordValue;
export const make = (options: RouterOptions = {}): Router => ({
	route: (update) => {
		const value = root(update);
		if (
			value.my_chat_member !== undefined ||
			value.chat_member !== undefined ||
			value.chat_join_request !== undefined
		)
			return (
				options.lifecycle?.(update) ?? Effect.succeed(DispatchOutcome.handled)
			);
		const beforeConversation =
			options.beforeConversation?.(update) ?? Effect.succeed(undefined);
		return Effect.gen(function* () {
			const beforeConversationResult = yield* beforeConversation;
			if (beforeConversationResult !== undefined)
				return beforeConversationResult;

			const conversation = yield* (
				options.conversation?.(update) ?? Effect.succeed(undefined)
			);
			if (conversation !== undefined) return conversation;

			const command = yield* (
				options.command?.(update) ?? Effect.succeed(undefined)
			);
			if (command !== undefined) return command;

			if (value.callback_query !== undefined) {
				const callback =
					options.callback?.(update) ??
					Effect.succeed(DispatchOutcome.permanentInvalid('Unhandled callback'));
				return yield* callback;
			}

			if (
				value.message !== undefined ||
				value.edited_message !== undefined ||
				value.channel_post !== undefined ||
				value.edited_channel_post !== undefined ||
				value.business_message !== undefined ||
				value.edited_business_message !== undefined ||
				value.message_reaction !== undefined
			) {
				const message = yield* (
					options.message?.(update) ?? Effect.succeed(undefined)
				);
				if (message !== undefined) return message;
			}

			const fallback =
				options.fallback?.(update) ?? Effect.succeed(DispatchOutcome.handled);
			return yield* fallback;
		});
	},
});
