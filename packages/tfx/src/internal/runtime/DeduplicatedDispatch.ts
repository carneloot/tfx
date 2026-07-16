import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import type {
	UpdateDeduplicatorError,
	UpdateDeduplicatorService,
} from '../../UpdateDeduplicator.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
class ClaimLost {
	readonly _tag = 'ClaimLost';
}
export const dispatch = (
	dedup: UpdateDeduplicatorService,
	update: Update,
	behavior: Effect.Effect<DispatchOutcome.DispatchOutcome, never>,
	options: {
		readonly leaseDuration?: Duration.Duration;
		readonly waitTimeout?: Duration.Duration;
		readonly retention?: Duration.Duration;
		readonly heartbeatInterval?: Duration.Duration;
	} = {},
): Effect.Effect<DispatchOutcome.DispatchOutcome, never> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const leaseDuration = options.leaseDuration ?? Duration.seconds(30);
			const heartbeatInterval =
				options.heartbeatInterval ??
				Duration.millis(
					Math.max(1, Math.floor(Duration.toMillis(leaseDuration) / 3)),
				);
			if (
				!Duration.isFinite(heartbeatInterval) ||
				!Duration.isPositive(heartbeatInterval) ||
				!Duration.isLessThan(heartbeatInterval, leaseDuration)
			)
				return DispatchOutcome.fatal(
					'heartbeatInterval must be finite, positive, and less than leaseDuration',
				);
			const claim = yield* restore(
				dedup.claim(update.update_id, {
					leaseDuration,
					...(options.waitTimeout === undefined
						? {}
						: { waitTimeout: options.waitTimeout }),
				}),
			);
			if (claim._tag === 'Completed') return claim.outcome;
			if (claim._tag === 'InProgress') {
				const observed = yield* restore(claim.await);
				return observed._tag === 'Completed'
					? observed.outcome
					: DispatchOutcome.retryableFailure(
							observed._tag === 'Released'
								? 'Concurrent dispatch released'
								: 'Concurrent dispatch still in progress',
						);
			}
			const monitor: Effect.Effect<never, ClaimLost | UpdateDeduplicatorError> =
				Effect.suspend(() =>
					Effect.flatMap(Effect.sleep(heartbeatInterval), () =>
						Effect.flatMap(
							dedup.heartbeat(claim.token, leaseDuration),
							(alive) => (alive ? monitor : Effect.fail(new ClaimLost())),
						),
					),
				);
			return yield* Effect.gen(function* () {
				const outcome = yield* restore(
					Effect.raceFirst(behavior, monitor).pipe(
						Effect.catchTag('ClaimLost', () =>
							Effect.succeed(
								DispatchOutcome.retryableFailure('Update claim lease lost'),
							),
						),
					),
				);
				if (DispatchOutcome.isAcknowledgeable(outcome)) {
					const completed = yield* dedup.complete(
						claim.token,
						outcome,
						options.retention,
					);
					return completed
						? outcome
						: DispatchOutcome.retryableFailure(
								'Update claim completion fence lost',
							);
				}
				return outcome;
			}).pipe(
				// Release is fenced; after completion this is a harmless stale release.
				Effect.ensuring(
					dedup.release(claim.token).pipe(Effect.catch(() => Effect.void)),
				),
			);
		}),
	).pipe(
		Effect.catch(() =>
			Effect.succeed(
				DispatchOutcome.retryableFailure('Update deduplication unavailable'),
			),
		),
	);
