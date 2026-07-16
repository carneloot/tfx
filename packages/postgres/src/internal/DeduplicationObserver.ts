import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import type { ObservedCompletion } from 'tfx/UpdateDeduplicator';

export interface Pending {
	readonly _tag: 'Pending';
}
export const pending: Pending = { _tag: 'Pending' };

type Observation = ObservedCompletion | Pending;
const isPending = (observation: Observation): observation is Pending =>
	observation._tag === 'Pending';

export const observe = <E, R>(options: {
	readonly startedAt: DateTime.Utc;
	readonly waitTimeout: Duration.Duration;
	readonly check: Effect.Effect<Observation, E, R>;
}): Effect.Effect<ObservedCompletion, E, R> => {
	const interval = Duration.min(Duration.millis(50), options.waitTimeout);
	const pass = Effect.flatMap(
		DateTime.now,
		(now): Effect.Effect<Observation, E, R> =>
			Duration.isGreaterThanOrEqualTo(
				DateTime.distance(options.startedAt, now),
				options.waitTimeout,
			)
				? Effect.succeed({ _tag: 'TimedOut' })
				: options.check,
	);
	return Effect.repeat(pass, {
		while: isPending,
		schedule: Schedule.spaced(interval).pipe(
			Schedule.setInputType<Observation>(),
		),
	});
};
