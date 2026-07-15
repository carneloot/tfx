import * as Effect from 'effect/Effect';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
export type Route =
	| 'lifecycle'
	| 'cancel'
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
	/** Optional username restricts /cancelar@mention to this bot. */
	readonly cancelBotUsername?: string;
	readonly lifecycle?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
	readonly cancel?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
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
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
	readonly fallback?: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
}
type RecordValue = Readonly<Record<string, any>>;
const root = (update: Update) => update as unknown as RecordValue;
const text = (update: Update) =>
	(root(update).message as RecordValue | undefined)?.text;
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
		if (typeof text(update) === 'string') {
			const cancel = /^\/cancelar(?:@([^\s]+))?(?:\s|$)/u.exec(text(update));
			const expected = options.cancelBotUsername
				?.replace(/^@/u, '')
				.toLocaleLowerCase('en-US');
			if (
				cancel !== null &&
				(expected === undefined ||
					cancel[1] === undefined ||
					cancel[1].toLocaleLowerCase('en-US') === expected)
			)
				return (
					options.cancel?.(update) ?? Effect.succeed(DispatchOutcome.handled)
				);
		}
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
							return (
								options.message?.(update) ??
								Effect.succeed(DispatchOutcome.handled)
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
});
