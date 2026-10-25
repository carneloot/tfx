import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type * as Job from './Job.js';
import { JobStore, type JobRecord, type JobStoreError } from './JobStore.js';

/** Application scheduling. All operations participate in the store's ambient transaction. */
export interface JobSchedulerService {
	/** A conflict key replaces the active job for the same declaration and key. */
	readonly schedule: <J extends Job.Job<any, any, any>>(
		job: J,
		payload: Job.Payload<J>,
		options?: { readonly runAt?: DateTime.Utc; readonly conflictKey?: string },
	) => Effect.Effect<
		{ readonly id: string; readonly replacedId?: string },
		JobStoreError
	>;
	readonly cancel: (id: string) => Effect.Effect<boolean, JobStoreError>;
	readonly inspect: (
		id: string,
	) => Effect.Effect<JobRecord | undefined, JobStoreError>;
}

export class JobScheduler extends Context.Service<
	JobScheduler,
	JobSchedulerService
>()('tfx/JobScheduler') {}

export const layer = Layer.effect(
	JobScheduler,
	Effect.gen(function* () {
		const store = yield* JobStore;
		return {
			schedule: Effect.fn('JobScheduler.schedule')(function* (
				job,
				payload,
				options = {},
			) {
				const now = yield* DateTime.now;
				const result = yield* store.schedule({
					name: job.name,
					payload,
					payloadVersion: job.payload.latest.version,
					maxAttempts: job.maxAttempts,
					runAt: options.runAt ?? now,
					now,
					...(options.conflictKey === undefined
						? {}
						: { conflictKey: options.conflictKey }),
				});
				yield* Effect.logInfo('tfx.job.scheduled').pipe(
					Effect.annotateLogs({
						jobId: result.record.id,
						jobName: result.record.name,
						replaced: result.replacedId !== undefined,
					}),
				);
				return {
					id: result.record.id,
					...(result.replacedId === undefined
						? {}
						: { replacedId: result.replacedId }),
				};
			}),
			cancel: Effect.fn('JobScheduler.cancel')(function* (id) {
				const cancelled = yield* Effect.flatMap(DateTime.now, (now) =>
					store.cancel(id, now),
				);
				if (cancelled)
					yield* Effect.logInfo('tfx.job.cancellation_requested').pipe(
						Effect.annotateLogs({ jobId: id }),
					);
				return cancelled;
			}),
			inspect: Effect.fn('JobScheduler.inspect')(store.get),
		} satisfies JobSchedulerService;
	}),
);
