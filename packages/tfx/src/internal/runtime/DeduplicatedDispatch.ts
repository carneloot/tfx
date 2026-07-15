import * as Effect from 'effect/Effect';

import * as DispatchOutcome from '../../DispatchOutcome.js';
import type { UpdateDeduplicatorService } from '../../UpdateDeduplicator.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
class ClaimLost {
	readonly _tag = 'ClaimLost';
}
export const dispatch = (
	dedup: UpdateDeduplicatorService,
	update: Update,
	behavior: Effect.Effect<DispatchOutcome.DispatchOutcome, never>,
	options: {
		readonly leaseDuration?: number;
		readonly waitTimeout?: number;
		readonly retention?: number;
	} = {},
): Effect.Effect<DispatchOutcome.DispatchOutcome, never> =>
	Effect.gen(function* () {
		const leaseDuration = options.leaseDuration ?? 30_000;
		const claim = yield* dedup.claim(update.update_id, {
			leaseDuration,
			...(options.waitTimeout === undefined
				? {}
				: { waitTimeout: options.waitTimeout }),
		});
		if (claim._tag === 'Completed') return claim.outcome;
		if (claim._tag === 'InProgress') {
			const observed = yield* claim.await;
			return observed._tag === 'Completed'
				? observed.outcome
				: DispatchOutcome.retryableFailure(
						observed._tag === 'Released'
							? 'Concurrent dispatch released'
							: 'Concurrent dispatch still in progress',
					);
		}
		const monitor: Effect.Effect<never, ClaimLost> = Effect.suspend(() =>
			Effect.flatMap(
				Effect.sleep(Math.max(1, Math.floor(leaseDuration / 3))),
				() =>
					Effect.flatMap(dedup.heartbeat(claim.token, leaseDuration), (alive) =>
						alive ? monitor : Effect.fail(new ClaimLost()),
					),
			),
		);
		const outcome = yield* Effect.raceFirst(behavior, monitor).pipe(
			Effect.catchTag('ClaimLost', () =>
				Effect.as(
					dedup.release(claim.token),
					DispatchOutcome.retryableFailure('Update claim lease lost'),
				),
			),
			Effect.onInterrupt(() => Effect.asVoid(dedup.release(claim.token))),
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
		yield* dedup.release(claim.token);
		return outcome;
	});
