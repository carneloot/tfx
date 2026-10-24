import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type { ObservedCompletion } from 'tfx/UpdateDeduplicator';

export interface Pending {
	readonly _tag: 'Pending';
}
export const pending: Pending = { _tag: 'Pending' };

type Observation = ObservedCompletion | Pending;
const isComplete = (
	observation: Observation,
): observation is ObservedCompletion => observation._tag !== 'Pending';

export const observe = <E, R>(options: {
	readonly startedAt: DateTime.Utc;
	readonly waitTimeout: Duration.Duration;
	readonly check: Effect.Effect<Observation, E, R>;
}): Effect.Effect<ObservedCompletion, E, R> => {
	const interval = Duration.min(Duration.millis(50), options.waitTimeout);
	const pass: Effect.Effect<Observation, E, R> = Effect.gen(function* () {
		const now = yield* DateTime.now;
		if (
			Duration.isGreaterThanOrEqualTo(
				DateTime.distance(options.startedAt, now),
				options.waitTimeout,
			)
		)
			return { _tag: 'TimedOut' };
		return yield* options.check;
	});
	const poll: Effect.Effect<ObservedCompletion, E, R> = Effect.flatMap(
		pass,
		(observation) =>
			isComplete(observation)
				? Effect.succeed(observation)
				: Effect.sleep(interval).pipe(Effect.andThen(() => poll)),
	);
	return poll;
};
