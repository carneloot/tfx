import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { ClaimToken } from './internal/job/ClaimToken.js';
import type { JobOutcome } from './JobOutcome.js';
export type JobStatus =
	| 'scheduled'
	| 'running'
	| 'completed'
	| 'failed'
	| 'quarantined'
	| 'cancelled';
export type LeasePhase = 'migration' | 'execution';
export interface JobRecord {
	readonly id: string;
	readonly name: string;
	readonly payload: unknown;
	readonly payloadVersion: number;
	readonly status: JobStatus;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly runAt: number;
	readonly conflictKey?: string | undefined;
	readonly leaseGeneration: number;
	readonly leasePhase?: LeasePhase | undefined;
	readonly leaseExpiresAt?: number | undefined;
	readonly cancellationRequested: boolean;
	readonly errorSummary?: string | undefined;
	readonly outcome?: JobOutcome | undefined;
	readonly createdAt: number;
	readonly updatedAt: number;
}
export class JobStoreError extends Error {
	readonly _tag = 'JobStoreError';
	constructor(
		readonly reason:
			| 'NotFound'
			| 'StaleToken'
			| 'InvalidState'
			| 'Conflict'
			| 'PersistenceFailure'
			| 'InvariantViolation',
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
	}
}
export interface ScheduleRequest {
	readonly name: string;
	readonly payload: unknown;
	readonly payloadVersion: number;
	readonly maxAttempts: number;
	readonly runAt: number;
	readonly now: number;
	readonly conflictKey?: string | undefined;
}
export interface JobStoreService {
	readonly schedule: (request: ScheduleRequest) => Effect.Effect<
		{
			readonly record: JobRecord;
			readonly replacedId?: string;
		},
		JobStoreError
	>;
	readonly get: (
		id: string,
	) => Effect.Effect<JobRecord | undefined, JobStoreError>;
	readonly problems: () => Effect.Effect<
		ReadonlyArray<JobRecord>,
		JobStoreError
	>;
	readonly claimForMigration: (
		now: number,
		leaseDuration: number,
	) => Effect.Effect<
		{ readonly record: JobRecord; readonly token: ClaimToken } | undefined,
		JobStoreError
	>;
	readonly promoteToRunning: (
		token: ClaimToken,
		payload: unknown,
		version: number,
		now: number,
		leaseDuration: number,
	) => Effect.Effect<JobRecord, JobStoreError>;
	readonly quarantineMigration: (
		token: ClaimToken,
		reason: string,
		now: number,
	) => Effect.Effect<JobRecord, JobStoreError>;
	readonly heartbeat: (
		token: ClaimToken,
		now: number,
		leaseDuration: number,
	) => Effect.Effect<boolean, JobStoreError>;
	readonly finalize: (
		token: ClaimToken,
		outcome: JobOutcome,
		now: number,
		retryAt?: number,
	) => Effect.Effect<boolean, JobStoreError>;
	readonly cancel: (
		id: string,
		now: number,
	) => Effect.Effect<boolean, JobStoreError>;
	readonly releaseFailed: (
		id: string,
		now: number,
		options: { readonly reason: string; readonly resetAttempts?: boolean },
	) => Effect.Effect<JobRecord, JobStoreError>;
}
export class JobStore extends Context.Service<JobStore, JobStoreService>()(
	'tfx/JobStore',
) {}
export type { ClaimToken };
