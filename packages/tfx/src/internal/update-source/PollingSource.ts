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
const retryBackoffMultipliers = [1, 2, 4, 8, 15, 30] as const;
const retryBackoffDelay = (
	attempt: number,
	initial: Duration.Duration,
): Duration.Duration =>
	Duration.times(
		initial,
		retryBackoffMultipliers[
			Math.min(attempt - 1, retryBackoffMultipliers.length - 1)
		]!,
	);
const retryBackoffSchedule = <Input>(initial: Duration.Duration) =>
	Schedule.forever.pipe(
		Schedule.setInputType<Input>(),
		Schedule.modifyDelay(({ attempt }) =>
			Effect.succeed(retryBackoffDelay(attempt, initial)),
		),
		Schedule.jittered,
	);

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
	run: Effect.fn('PollingSource.run')(function* (deliver) {
		yield* telegram.getMe();
		yield* telegram.deleteWebhook({
			drop_pending_updates: options.dropPendingUpdates ?? false,
		});
		if (options.commands !== undefined)
			yield* telegram.setMyCommands({
				commands: options.commands,
				language_code: options.languageCode ?? 'pt',
			});
		yield* Effect.logInfo('tfx.polling.ready').pipe(
			Effect.annotateLogs({
				commandsConfigured: options.commands?.length ?? 0,
				droppedPendingUpdates: options.dropPendingUpdates ?? false,
			}),
		);
		let offset: number | undefined;
		let first = true;
		const pollRetrySchedule = retryBackoffSchedule<TelegramError>(
			options.retryDelay,
		).pipe(
			Schedule.modifyDelay(({ duration, input }) =>
				Effect.succeed(
					input.reason._tag === 'RateLimitError'
						? input.reason.retryAfter
						: duration,
				),
			),
			Schedule.while(
				({ input }) => retryDelay(input, options.retryDelay) !== undefined,
			),
			Schedule.tap(({ attempt, duration, input }) =>
				Effect.logWarning('tfx.polling.request_retrying').pipe(
					Effect.annotateLogs({
						method: input.method,
						reason: input.reason._tag,
						retryAttempt: attempt,
						retryDelayMs: Duration.toMillis(duration),
					}),
				),
			),
		);
		const dispatchRetrySchedule = (updateId: number) =>
			retryBackoffSchedule<DispatchOutcome.DispatchOutcome>(
				options.retryDelay,
			).pipe(
				Schedule.passthrough,
				Schedule.while(({ input }) => input._tag === 'RetryableFailure'),
				Schedule.tap(({ attempt, duration }) =>
					Effect.logWarning('tfx.polling.dispatch_retrying').pipe(
						Effect.annotateLogs({
							updateId,
							retryAttempt: attempt,
							retryDelayMs: Duration.toMillis(duration),
						}),
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
					Effect.tapError((error) =>
						retryDelay(error, options.retryDelay) === undefined
							? Effect.logError('tfx.polling.request_failed').pipe(
									Effect.annotateLogs({
										method: error.method,
										reason: error.reason._tag,
									}),
								)
							: Effect.void,
					),
					Effect.retry(pollRetrySchedule),
				),
				(updates: ReadonlyArray<Update>) => {
					first = false;
					const receivedLog =
						updates.length === 0
							? Effect.void
							: Effect.logInfo('tfx.polling.batch_received').pipe(
									Effect.annotateLogs({ received: updates.length }),
								);
					return Effect.andThen(
						receivedLog,
						Effect.flatMap(
							Effect.forEach(
								updates,
								(update) =>
									Effect.suspend(() => deliver(update)).pipe(
										Effect.repeat(dispatchRetrySchedule(update.update_id)),
										Effect.flatMap((outcome) =>
											outcome._tag === 'Fatal'
												? Effect.andThen(
														Effect.logError('tfx.polling.dispatch_fatal').pipe(
															Effect.annotateLogs({
																updateId: update.update_id,
															}),
														),
														Effect.fail(
															new FatalPollingDispatchError({
																updateId: update.update_id,
															}),
														),
													)
												: Effect.succeed({ update, outcome }),
										),
									),
								{ concurrency: 'unbounded' },
							),
							(settled) => {
								const ordered = [...settled].sort(
									(a, b) => a.update.update_id - b.update.update_id,
								);
								let acknowledged = 0;
								for (const item of ordered) {
									if (!DispatchOutcome.isAcknowledgeable(item.outcome)) break;
									offset = item.update.update_id + 1;
									acknowledged++;
								}
								return updates.length === 0
									? Effect.void
									: Effect.logInfo('tfx.polling.batch_acknowledged').pipe(
											Effect.annotateLogs({
												received: updates.length,
												acknowledged,
												...(offset === undefined ? {} : { nextOffset: offset }),
											}),
										);
							},
						),
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
