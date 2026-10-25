import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { JobStoreError } from './JobStore.js';

export interface Snapshot {
	/** Earliest runnable job or recoverable lease, in epoch milliseconds. */
	readonly deadline: number | undefined;
	readonly receipts: ReadonlyArray<{
		readonly id: string;
		readonly revision: string;
	}>;
}

/** Recoverable handoff from transactional scheduling to a native executor. */
export class JobWakeup extends Context.Service<
	JobWakeup,
	{
		readonly snapshot: Effect.Effect<Snapshot, JobStoreError>;
		/** Call only after the platform has durably armed the snapshot's deadline. */
		readonly acknowledge: (
			snapshot: Snapshot,
		) => Effect.Effect<void, JobStoreError>;
	}
>()('tfx/JobWakeup') {}
