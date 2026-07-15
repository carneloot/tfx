import * as Data from 'effect/Data';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import { Telegram, type TelegramService } from '../../Telegram.js';
import type { TelegramError } from '../../TelegramError.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
import type { UpdateSourceService } from './UpdateSource.js';
export class FatalPollingDispatchError extends Data.TaggedError(
	'FatalPollingDispatchError',
)<{ readonly updateId: number }> {}

export interface PollingOptions {
	readonly timeout?: number;
	readonly limit?: number;
	readonly allowedUpdates?: ReadonlyArray<string>;
	readonly commands?: ReadonlyArray<{
		readonly command: string;
		readonly description: string;
	}>;
	readonly languageCode?: string;
	readonly dropPendingUpdates?: boolean;
	readonly retryDelay?: number;
}
const retryDelay = (
	error: TelegramError,
	fallback: number,
): number | undefined => {
	const reason = error.reason;
	if (
		reason._tag === 'AuthenticationError' ||
		reason._tag === 'ConflictError' ||
		reason._tag === 'ForbiddenError' ||
		reason._tag === 'InvalidRequestError' ||
		reason._tag === 'InvalidResponseError' ||
		reason._tag === 'UnknownError'
	)
		return undefined;
	return reason._tag === 'RateLimitError'
		? Duration.toMillis(reason.retryAfter)
		: fallback;
};
export const make = (
	telegram: TelegramService,
	options: PollingOptions,
): UpdateSourceService => ({
	run: (deliver) =>
		Effect.gen(function* () {
			yield* telegram.getMe();
			yield* telegram.deleteWebhook({
				drop_pending_updates: options.dropPendingUpdates ?? false,
			});
			if (options.commands !== undefined)
				yield* telegram.setMyCommands({
					commands: options.commands,
					language_code: options.languageCode ?? 'pt',
				});
			let offset: number | undefined;
			let first = true;
			const poll: Effect.Effect<
				void,
				TelegramError | FatalPollingDispatchError
			> = Effect.suspend(() => {
				const request = telegram.getUpdates({
					...(offset === undefined ? {} : { offset }),
					limit: options.limit ?? 100,
					timeout: options.timeout ?? 30,
					...(first && options.allowedUpdates !== undefined
						? { allowed_updates: options.allowedUpdates }
						: {}),
				});
				return Effect.matchEffect(request, {
					onFailure: (error) => {
						const delay = retryDelay(error, options.retryDelay ?? 1000);
						return delay === undefined
							? Effect.fail(error)
							: Effect.andThen(Effect.sleep(delay), poll);
					},
					onSuccess: (updates: ReadonlyArray<Update>) => {
						first = false;
						return Effect.flatMap(
							Effect.forEach(
								updates,
								(update) =>
									Effect.map(deliver(update), (outcome) => ({
										update,
										outcome,
									})),
								{ concurrency: 'unbounded' },
							),
							(settled) => {
								const ordered = [...settled].sort(
									(a, b) => a.update.update_id - b.update.update_id,
								);
								for (const item of ordered) {
									if (DispatchOutcome.isTerminal(item.outcome))
										return Effect.fail(
											new FatalPollingDispatchError({
												updateId: item.update.update_id,
											}),
										);
									if (!DispatchOutcome.isAcknowledgeable(item.outcome)) break;
									offset = item.update.update_id + 1;
								}
								return poll;
							},
						);
					},
				});
			});
			return yield* poll;
		}),
});
export const fromContext = (
	options: PollingOptions,
): Effect.Effect<UpdateSourceService, never, Telegram> =>
	Effect.map(Telegram, (telegram) => make(telegram, options));
