import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { CompletedOutcome } from './DispatchOutcome.js';
export interface ClaimToken {
	readonly updateId: number;
	readonly generation: number;
}
export type ObservedCompletion =
	| { readonly _tag: 'Completed'; readonly outcome: CompletedOutcome }
	| { readonly _tag: 'Released' }
	| { readonly _tag: 'TimedOut' };
export class UpdateDeduplicatorError extends Error {
	readonly _tag = 'UpdateDeduplicatorError';
	constructor(
		readonly reason: 'PersistenceFailure' | 'InvariantViolation',
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
	}
}
export type Claim =
	| { readonly _tag: 'Acquired'; readonly token: ClaimToken }
	| { readonly _tag: 'Completed'; readonly outcome: CompletedOutcome }
	| {
			readonly _tag: 'InProgress';
			readonly await: Effect.Effect<
				ObservedCompletion,
				UpdateDeduplicatorError
			>;
	  };
export interface Diagnostics {
	readonly mode: 'none' | 'memory' | 'durable';
	readonly backend: string;
}
export interface UpdateDeduplicatorService {
	readonly diagnostics: Diagnostics;
	readonly claim: (
		updateId: number,
		options?: {
			readonly leaseDuration?: number;
			readonly waitTimeout?: number;
		},
	) => Effect.Effect<Claim, UpdateDeduplicatorError>;
	readonly heartbeat: (
		token: ClaimToken,
		leaseDuration?: number,
	) => Effect.Effect<boolean, UpdateDeduplicatorError>;
	readonly complete: (
		token: ClaimToken,
		outcome: CompletedOutcome,
		retention?: number,
	) => Effect.Effect<boolean, UpdateDeduplicatorError>;
	readonly release: (
		token: ClaimToken,
	) => Effect.Effect<boolean, UpdateDeduplicatorError>;
}
export class UpdateDeduplicator extends Context.Service<
	UpdateDeduplicator,
	UpdateDeduplicatorService
>()('tfx/UpdateDeduplicator') {}

/** Explicit opt-out. Every claim is acquired independently and duplicates are possible. */
export const layerNoop: Layer.Layer<UpdateDeduplicator> = Layer.effect(
	UpdateDeduplicator,
	Effect.sync(() => {
		let generation = 0;
		return {
			diagnostics: { mode: 'none' as const, backend: 'noop' },
			claim: (updateId: number) =>
				Effect.succeed({
					_tag: 'Acquired' as const,
					token: { updateId, generation: ++generation },
				}),
			heartbeat: () => Effect.succeed(true),
			complete: () => Effect.succeed(true),
			release: () => Effect.succeed(true),
		};
	}),
);
