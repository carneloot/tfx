import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
export interface RecordedRequest {
	readonly method: string;
	readonly input: unknown;
}
export interface RecordedRequestsService {
	readonly all: Effect.Effect<ReadonlyArray<RecordedRequest>>;
	readonly method: (
		name: string,
	) => Effect.Effect<ReadonlyArray<RecordedRequest>>;
	readonly count: (name?: string) => Effect.Effect<number>;
	readonly assertConsumed: Effect.Effect<void>;
}
export class RecordedRequests extends Context.Service<
	RecordedRequests,
	RecordedRequestsService
>()('tfx/test/RecordedRequests') {}
