import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { AppConfig, type AppConfigService } from './Config.js';
import * as DomainLive from './DomainLive.js';
import * as PersistenceLive from './PersistenceLive.js';
import * as RuntimeLive from './RuntimeLive.js';

/** Shared domain graph, without acquiring a polling source or job worker. */
export const applicationLayer = Layer.unwrap(
	Effect.map(AppConfig, (config) =>
		Layer.provideMerge(DomainLive.layer, PersistenceLive.layer(config)),
	),
);

export const layer = <D extends UpdateDelivery.UpdateDelivery<any, any, any>>(
	delivery: (config: AppConfigService) => D,
) =>
	Layer.provide(
		Layer.unwrap(
			Effect.map(AppConfig, (config) =>
				RuntimeLive.layer(config, delivery(config)),
			),
		),
		applicationLayer,
	);
