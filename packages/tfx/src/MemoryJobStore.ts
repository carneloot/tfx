import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';

import {
	JobStore,
	JobStoreError,
	type JobRecord,
	type JobStoreService,
} from './JobStore.js';
const make: Effect.Effect<JobStoreService> = Effect.gen(function* () {
	const records = new Map<string, JobRecord>();
	const semaphore = yield* Semaphore.make(1);
	const locked = <A, E, R>(effect: () => Effect.Effect<A, E, R>) =>
		semaphore.withPermit(Effect.suspend(effect));
	const update = (record: JobRecord) => {
		const frozen = Object.freeze(record);
		records.set(record.id, frozen);
		return frozen;
	};
	const tokenMatch = (
		record: JobRecord | undefined,
		token: { id: string; generation: number },
		phase?: string,
	) =>
		record !== undefined &&
		record.leaseGeneration === token.generation &&
		(phase === undefined || record.leasePhase === phase);
	return {
		schedule: (request) =>
			locked(() =>
				Effect.sync(() => {
					const { now, ...values } = request;
					let replacedId: string | undefined;
					if (request.conflictKey !== undefined)
						for (const row of records.values())
							if (
								row.name === request.name &&
								row.conflictKey === request.conflictKey &&
								(row.status === 'scheduled' || row.status === 'running')
							) {
								replacedId = row.id;
								update({
									...row,
									status: 'cancelled',
									cancellationRequested: true,
									outcome: { _tag: 'Cancelled' },
									leasePhase: undefined,
									leaseExpiresAt: undefined,
									updatedAt: now,
								});
							}
					const record = update({
						id: crypto.randomUUID(),
						...values,
						status: 'scheduled',
						attempts: 0,
						leaseGeneration: 0,
						cancellationRequested: false,
						createdAt: now,
						updatedAt: now,
					});
					return {
						record,
						...(replacedId === undefined ? {} : { replacedId }),
					};
				}),
			),
		get: (id) => locked(() => Effect.succeed(records.get(id))),
		problems: () =>
			locked(() =>
				Effect.succeed(
					[...records.values()]
						.filter(
							(record) =>
								record.status === 'failed' || record.status === 'quarantined',
						)
						.sort(
							(a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id),
						),
				),
			),
		claimForMigration: (now, leaseDuration) =>
			locked(() =>
				Effect.sync(() => {
					for (const row of [...records.values()].sort(
						(a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt,
					))
						if (
							row.status === 'running' &&
							row.leasePhase === 'execution' &&
							row.leaseExpiresAt! <= now
						) {
							if (row.attempts >= row.maxAttempts) {
								update({
									...row,
									status: 'failed',
									leasePhase: undefined,
									leaseExpiresAt: undefined,
									outcome: { _tag: 'LeaseLost' },
									errorSummary: 'AttemptsExhausted',
									updatedAt: now,
								});
								continue;
							}
							const reclaimed = update({
								...row,
								status: 'scheduled',
								leasePhase: 'migration',
								leaseGeneration: row.leaseGeneration + 1,
								leaseExpiresAt: now + leaseDuration,
								outcome: { _tag: 'LeaseLost' },
								updatedAt: now,
							});
							return {
								record: reclaimed,
								token: {
									id: reclaimed.id,
									generation: reclaimed.leaseGeneration,
								},
							};
						}
					const candidate = [...records.values()]
						.filter(
							(r) =>
								r.status === 'scheduled' &&
								r.runAt <= now &&
								(r.leaseExpiresAt === undefined || r.leaseExpiresAt <= now),
						)
						.sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)[0];
					if (candidate === undefined) return undefined;
					const record = update({
						...candidate,
						leasePhase: 'migration',
						leaseGeneration: candidate.leaseGeneration + 1,
						leaseExpiresAt: now + leaseDuration,
						updatedAt: now,
					});
					return {
						record,
						token: { id: record.id, generation: record.leaseGeneration },
					};
				}),
			),
		promoteToRunning: (token, payload, version, now, leaseDuration) =>
			locked(() => {
				const row = records.get(token.id);
				if (
					!tokenMatch(row, token, 'migration') ||
					row!.leaseExpiresAt === undefined ||
					row!.leaseExpiresAt <= now
				)
					return Effect.fail(
						new JobStoreError('StaleToken', 'Migration lease lost'),
					);
				if (row!.attempts >= row!.maxAttempts)
					return Effect.fail(
						new JobStoreError('InvalidState', 'Attempts exhausted'),
					);
				return Effect.succeed(
					update({
						...row!,
						payload,
						payloadVersion: version,
						status: 'running',
						attempts: row!.attempts + 1,
						leasePhase: 'execution',
						leaseExpiresAt: now + leaseDuration,
						updatedAt: now,
					}),
				);
			}),
		quarantineMigration: (token, reason, now) =>
			locked(() => {
				const row = records.get(token.id);
				return !tokenMatch(row, token, 'migration') ||
					row!.leaseExpiresAt === undefined ||
					row!.leaseExpiresAt <= now
					? Effect.fail(new JobStoreError('StaleToken', 'Migration lease lost'))
					: Effect.succeed(
							update({
								...row!,
								status: 'quarantined',
								leasePhase: undefined,
								leaseExpiresAt: undefined,
								errorSummary: reason,
								updatedAt: now,
							}),
						);
			}),
		heartbeat: (token, now, duration) =>
			locked(() =>
				Effect.sync(() => {
					const row = records.get(token.id);
					if (!tokenMatch(row, token, 'execution')) return false;
					update({ ...row!, leaseExpiresAt: now + duration, updatedAt: now });
					return true;
				}),
			),
		finalize: (token, outcome, now, retryAt) =>
			locked(() =>
				Effect.sync(() => {
					const row = records.get(token.id);
					if (!tokenMatch(row, token, 'execution')) return false;
					const status =
						outcome._tag === 'Succeeded'
							? 'completed'
							: outcome._tag === 'Cancelled'
								? 'cancelled'
								: outcome._tag === 'RetryableFailure' &&
									  retryAt !== undefined &&
									  row!.attempts < row!.maxAttempts
									? 'scheduled'
									: outcome._tag === 'FatalFailure'
										? 'quarantined'
										: 'failed';
					update({
						...row!,
						status,
						runAt: status === 'scheduled' ? retryAt! : row!.runAt,
						leasePhase: undefined,
						leaseExpiresAt: undefined,
						outcome,
						errorSummary: outcome._tag.includes('Failure')
							? outcome._tag
							: undefined,
						updatedAt: now,
					});
					return true;
				}),
			),
		cancel: (id, now) =>
			locked(() =>
				Effect.sync(() => {
					const row = records.get(id);
					if (
						row === undefined ||
						!['scheduled', 'running'].includes(row.status)
					)
						return false;
					update(
						row.status === 'scheduled'
							? {
									...row,
									status: 'cancelled',
									cancellationRequested: true,
									outcome: { _tag: 'Cancelled' },
									leasePhase: undefined,
									leaseExpiresAt: undefined,
									updatedAt: now,
								}
							: { ...row, cancellationRequested: true, updatedAt: now },
					);
					return true;
				}),
			),
		releaseFailed: (id, now, options) =>
			locked(() => {
				const row = records.get(id);
				if (row === undefined)
					return Effect.fail(new JobStoreError('NotFound', 'Unknown job'));
				if (row.status !== 'failed' && row.status !== 'quarantined')
					return Effect.fail(
						new JobStoreError(
							'InvalidState',
							'Only failed or quarantined jobs can be released',
						),
					);
				return Effect.succeed(
					update({
						...row,
						status: 'scheduled',
						attempts: options.resetAttempts ? 0 : row.attempts,
						runAt: now,
						errorSummary: options.reason,
						outcome: undefined,
						updatedAt: now,
					}),
				);
			}),
	};
});
export const layer: Layer.Layer<JobStore> = Layer.effect(JobStore, make);
