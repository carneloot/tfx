import * as Data from 'effect/Data';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import { Telegram, type TelegramService } from '../../Telegram.js';
import type { TelegramError } from '../../TelegramError.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
import type { UpdateSourceService } from './UpdateSource.js';
export class FatalPollingDispatchError extends Data.TaggedError(
	'FatalPollingDispatchError',
)<{ readonly updateId: number }> {}

export interface PollingOptions {
	readonly timeout?: Duration.Input;
	readonly limit?: number;
	readonly allowedUpdates?: ReadonlyArray<string>;
	readonly commands?: ReadonlyArray<{
		readonly command: string;
		readonly description: string;
	}>;
	readonly languageCode?: string;
	readonly dropPendingUpdates?: boolean;
	readonly retryDelay?: Duration.Input;
}
export interface NormalizedPollingOptions extends Omit<
	PollingOptions,
	'timeout' | 'retryDelay'
> {
	readonly timeout: Duration.Duration;
	readonly retryDelay: Duration.Duration;
}
const retryDelay = (
	error: TelegramError,
	fallback: Duration.Duration,
): Duration.Duration | undefined => {
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
	return reason._tag === 'RateLimitError' ? reason.retryAfter : fallback;
};
export const make = (
	telegram: TelegramService,
	options: NormalizedPollingOptions,
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
			const pollRetrySchedule = Schedule.forever.pipe(
				Schedule.setInputType<TelegramError>(),
				Schedule.modifyDelay(({ input }) =>
					Effect.succeed(
						retryDelay(input, options.retryDelay) ?? Duration.zero,
					),
				),
			);
			const pollOnce: Effect.Effect<
				void,
				TelegramError | FatalPollingDispatchError
			> = Effect.suspend(() =>
				Effect.flatMap(
					Effect.suspend(() =>
						telegram.getUpdates({
							...(offset === undefined ? {} : { offset }),
							limit: options.limit ?? 100,
							timeout: Duration.toSeconds(options.timeout),
							...(first && options.allowedUpdates !== undefined
								? { allowed_updates: options.allowedUpdates }
								: {}),
						}),
					).pipe(
						Effect.retry({
							while: (error) =>
								retryDelay(error, options.retryDelay) !== undefined,
							schedule: pollRetrySchedule,
						}),
					),
					(updates: ReadonlyArray<Update>) => {
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
								return Effect.void;
							},
						);
					},
				),
			);
			return yield* pollOnce.pipe(
				Effect.repeat(Schedule.forever),
				Effect.andThen(Effect.never),
			);
		}),
});
export const fromContext = (
	options: NormalizedPollingOptions,
): Effect.Effect<UpdateSourceService, never, Telegram> =>
	Effect.map(Telegram, (telegram) => make(telegram, options));
