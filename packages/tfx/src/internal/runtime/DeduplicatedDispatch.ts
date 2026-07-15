import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

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
		const exit = yield* Effect.exit(Effect.raceFirst(behavior, monitor));
		if (Exit.isFailure(exit)) {
			yield* dedup.release(claim.token);
			return DispatchOutcome.retryableFailure('Update claim lease lost');
		}
		const outcome = exit.value;
		if (DispatchOutcome.isAcknowledgeable(outcome))
			yield* dedup.complete(claim.token, outcome, options.retention);
		else yield* dedup.release(claim.token);
		return outcome;
	});
