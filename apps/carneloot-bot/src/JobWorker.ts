import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import { JobRuntime } from 'tfx/JobRuntime';
import type { JobRecord } from 'tfx/JobStore';

import { NotificationRepository } from './ports/NotificationRepository.js';

export interface JobWorkerDiagnostics {
	readonly recoveredDeliveries: number;
	readonly startupProblems: ReadonlyArray<JobRecord>;
}
export interface JobWorkerService {
	readonly await: Effect.Effect<void, unknown>;
	readonly diagnostics: JobWorkerDiagnostics;
	readonly problems: Effect.Effect<ReadonlyArray<JobRecord>, unknown>;
}
export class JobWorker extends Context.Service<JobWorker, JobWorkerService>()(
	'carneloot/JobWorker',
) {}
export interface Options {
	readonly idleDelay: number;
	readonly leaseDuration: number;
}
const validate = (value: number, name: string) => {
	if (!Number.isFinite(value) || value <= 0)
		throw new TypeError(`${name} must be finite and positive`);
};
export const layer = (
	options: Options,
): Layer.Layer<JobWorker, unknown, JobRuntime | NotificationRepository> =>
	Layer.effect(
		JobWorker,
		Effect.gen(function* () {
			validate(options.idleDelay, 'idleDelay');
			validate(options.leaseDuration, 'leaseDuration');
			const jobs = yield* JobRuntime;
			const notifications = yield* NotificationRepository;
			const now = yield* Clock.currentTimeMillis;
			const recoveredDeliveries = yield* notifications.recoverAllExpired(now);
			const startupProblems = yield* jobs.problems;
			const loop: Effect.Effect<void, unknown> = Effect.suspend(() =>
				Effect.flatMap(
					jobs.runOne({ leaseDuration: options.leaseDuration }),
					(record) =>
						record === undefined
							? Effect.andThen(Effect.sleep(options.idleDelay), loop)
							: loop,
				),
			);
			const fiber = yield* Effect.forkScoped(loop);
			return Object.freeze({
				await: Fiber.join(fiber),
				diagnostics: Object.freeze({
					recoveredDeliveries,
					startupProblems,
				}),
				problems: jobs.problems,
			});
		}),
	);
