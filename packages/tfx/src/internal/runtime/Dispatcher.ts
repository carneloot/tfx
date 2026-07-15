import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import type { DispatchOutcome } from '../../DispatchOutcome.js';
import type { Partitioning } from '../../Partitioning.js';
import type { UpdateDeduplicatorService } from '../../UpdateDeduplicator.js';
import { fromUpdate } from '../../UpdateRoutingScope.js';
import type { Update } from '../telegram/generated/TelegramApi.types.js';
import * as DeduplicatedDispatch from './DeduplicatedDispatch.js';
import * as KeyedExecutor from './KeyedExecutor.js';
import type { Router } from './Router.js';
export interface Dispatcher {
	readonly dispatch: (update: Update) => Effect.Effect<DispatchOutcome, never>;
}
export const make = (options: {
	readonly botId: string;
	readonly partitioning: Partitioning;
	readonly concurrency: number;
	readonly capacity: number;
	readonly deduplicator: UpdateDeduplicatorService;
	readonly router: Router;
}): Effect.Effect<Dispatcher, never, Scope.Scope> =>
	Effect.map(KeyedExecutor.make(options), (executor) => ({
		dispatch: (update) => {
			const scope = fromUpdate(options.botId, update);
			return executor.submit(
				options.partitioning(scope),
				DeduplicatedDispatch.dispatch(
					options.deduplicator,
					update,
					options.router.route(update),
				),
			);
		},
	}));
