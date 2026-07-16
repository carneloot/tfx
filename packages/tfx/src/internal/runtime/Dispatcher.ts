import * as Duration from 'effect/Duration';
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
	readonly leaseDuration?: Duration.Duration;
	readonly waitTimeout?: Duration.Duration;
	readonly retention?: Duration.Duration;
	readonly heartbeatInterval?: Duration.Duration;
}): Effect.Effect<Dispatcher, never, Scope.Scope> =>
	Effect.map(KeyedExecutor.make(options), (executor) => ({
		dispatch: (update) => {
			const scope = fromUpdate(options.botId, update);
			return executor
				.submit(
					options.partitioning(scope),
					DeduplicatedDispatch.dispatch(
						options.deduplicator,
						update,
						options.router.route(update),
						{
							...(options.leaseDuration === undefined
								? {}
								: { leaseDuration: options.leaseDuration }),
							...(options.waitTimeout === undefined
								? {}
								: { waitTimeout: options.waitTimeout }),
							...(options.retention === undefined
								? {}
								: { retention: options.retention }),
							...(options.heartbeatInterval === undefined
								? {}
								: { heartbeatInterval: options.heartbeatInterval }),
						},
					),
				)
				.pipe(
					Effect.tap((outcome) => {
						const log =
							outcome._tag === 'Fatal'
								? Effect.logError
								: outcome._tag === 'RetryableFailure' ||
									  outcome._tag === 'HandledWithOutputFailure'
									? Effect.logWarning
									: Effect.logInfo;
						return log('tfx.dispatch.completed').pipe(
							Effect.annotateLogs({
								botId: options.botId,
								updateId: update.update_id,
								outcome: outcome._tag,
							}),
						);
					}),
				);
		},
	}));
