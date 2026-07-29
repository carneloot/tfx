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
		return Effect.flatMap(
			options.beforeConversation?.(update) ?? Effect.succeed(undefined),
			(beforeConversation) => {
				if (beforeConversation !== undefined)
					return Effect.succeed(beforeConversation);
				return Effect.flatMap(
					options.conversation?.(update) ?? Effect.succeed(undefined),
					(conversation) => {
						if (conversation !== undefined) return Effect.succeed(conversation);
						return Effect.flatMap(
							options.command?.(update) ?? Effect.succeed(undefined),
							(command) => {
								if (command !== undefined) return Effect.succeed(command);
								if (value.callback_query !== undefined)
									return (
										options.callback?.(update) ??
										Effect.succeed(
											DispatchOutcome.permanentInvalid('Unhandled callback'),
										)
									);
								if (
									value.message !== undefined ||
									value.edited_message !== undefined ||
									value.channel_post !== undefined ||
									value.edited_channel_post !== undefined ||
									value.business_message !== undefined ||
									value.edited_business_message !== undefined ||
									value.message_reaction !== undefined
								)
									return Effect.flatMap(
										options.message?.(update) ?? Effect.succeed(undefined),
										(message) =>
											message === undefined
												? (options.fallback?.(update) ??
													Effect.succeed(DispatchOutcome.handled))
												: Effect.succeed(message),
									);
								return (
									options.fallback?.(update) ??
									Effect.succeed(DispatchOutcome.handled)
								);
							},
						);
					},
				);
			},
		);
	},
});
