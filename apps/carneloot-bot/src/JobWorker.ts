import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import { JobRuntime, type JobRuntimeOptionsError } from 'tfx/JobRuntime';
import { JobStoreError, type JobRecord } from 'tfx/JobStore';

import {
	NotificationRepository,
	type NotificationRepositoryError,
} from './ports/NotificationRepository.js';

export class JobWorkerOptionsError extends Data.TaggedError(
	'JobWorkerOptionsError',
)<{
	readonly option: 'idleDelay' | 'leaseDuration' | 'heartbeatInterval';
	readonly message: string;
}> {}
export type JobWorkerError =
	| JobStoreError
	| JobRuntimeOptionsError
	| NotificationRepositoryError
	| JobWorkerOptionsError;

export interface JobWorkerDiagnostics {
	readonly recoveredDeliveries: number;
	readonly startupProblems: ReadonlyArray<JobRecord>;
	readonly failedJobIds: ReadonlyArray<string>;
	readonly quarantinedJobIds: ReadonlyArray<string>;
}
export interface JobWorkerService {
	readonly await: Effect.Effect<void, JobWorkerError>;
	readonly diagnostics: JobWorkerDiagnostics;
	readonly problems: Effect.Effect<ReadonlyArray<JobRecord>, JobStoreError>;
}
export class JobWorker extends Context.Service<JobWorker, JobWorkerService>()(
	'carneloot/JobWorker',
) {}
export interface Options {
	readonly idleDelay: Duration.Input;
	readonly leaseDuration: Duration.Input;
	readonly heartbeatInterval: Duration.Input;
}
const validate = (
	value: Duration.Duration,
	option: 'idleDelay' | 'leaseDuration' | 'heartbeatInterval',
) =>
	Duration.isFinite(value) &&
	!Duration.isZero(value) &&
	!Duration.isNegative(value)
		? Effect.void
		: Effect.fail(
				new JobWorkerOptionsError({
					option,
					message: `${option} must be a finite positive duration`,
				}),
			);
const normalize = (
	input: Duration.Input,
	option: 'idleDelay' | 'leaseDuration' | 'heartbeatInterval',
) =>
	Option.match(Duration.fromInput(input), {
		onNone: () =>
			Effect.fail(
				new JobWorkerOptionsError({
					option,
					message: `${option} must be a valid duration`,
				}),
			),
		onSome: (value) => Effect.as(validate(value, option), value),
	});
export const layer = (options: Options) =>
	Layer.effect(
		JobWorker,
		Effect.gen(function* () {
			const idleDelay = yield* normalize(options.idleDelay, 'idleDelay');
			const leaseDuration = yield* normalize(
				options.leaseDuration,
				'leaseDuration',
			);
			const heartbeatInterval = yield* normalize(
				options.heartbeatInterval,
				'heartbeatInterval',
			);
			if (!Duration.isLessThan(heartbeatInterval, leaseDuration))
				return yield* Effect.fail(
					new JobWorkerOptionsError({
						option: 'heartbeatInterval',
						message: 'heartbeatInterval must be less than leaseDuration',
					}),
				);
			const jobs = yield* JobRuntime;
			const notifications = yield* NotificationRepository;
			const now = yield* DateTime.now;
			const recoveredDeliveries = yield* notifications.recoverAllExpired(now);
			const startupProblems = yield* jobs.problems;
			const failedJobIds = startupProblems
				.filter((job) => job.status === 'failed')
				.map((job) => job.id);
			const quarantinedJobIds = startupProblems
				.filter((job) => job.status === 'quarantined')
				.map((job) => job.id);
			const startupLog =
				recoveredDeliveries > 0 || startupProblems.length > 0
					? Effect.logWarning
					: Effect.logInfo;
			yield* startupLog('carneloot.worker.initialized').pipe(
				Effect.annotateLogs({
					recoveredDeliveries,
					failedJobs: failedJobIds.length,
					quarantinedJobs: quarantinedJobIds.length,
				}),
			);
			const persistenceRetry = Schedule.exponential(idleDelay).pipe(
				Schedule.jittered,
				Schedule.upTo({ times: 5 }),
			);
			const runOnePass = Effect.suspend(() =>
				jobs.runOne({ leaseDuration, heartbeatInterval }),
			).pipe(
				Effect.retry({
					while: (error) =>
						error instanceof JobStoreError &&
						error.reason === 'PersistenceFailure',
					schedule: persistenceRetry,
				}),
				Effect.catchIf(
					(error) =>
						error instanceof JobStoreError &&
						error.reason === 'PersistenceFailure',
					() =>
						Effect.logWarning(
							'carneloot.worker.persistence_retry_exhausted',
						).pipe(Effect.annotateLogs({ attempts: 6 }), Effect.as(undefined)),
				),
				Effect.withSpan('JobWorker.runOnePass'),
			);
			const loopSchedule = Schedule.forever.pipe(
				Schedule.setInputType<JobRecord | undefined>(),
				Schedule.modifyDelay(({ input }) =>
					Effect.succeed(input === undefined ? idleDelay : Duration.zero),
				),
			);
			const loop = runOnePass.pipe(
				Effect.repeat(loopSchedule),
				Effect.andThen(Effect.never),
			);

			const fiber = yield* Effect.forkScoped(loop);

			return Object.freeze({
				await: Fiber.join(fiber),
				diagnostics: Object.freeze({
					recoveredDeliveries,
					startupProblems,
					failedJobIds,
					quarantinedJobIds,
				}),
				problems: jobs.problems,
			});
		}),
	);
