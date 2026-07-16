import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { AppConfig, type AppConfigService } from './Config.js';
import * as DomainLive from './DomainLive.js';
import * as PersistenceLive from './PersistenceLive.js';
import * as RuntimeLive from './RuntimeLive.js';

export const layer = <D extends UpdateDelivery.UpdateDelivery<any, any, any>>(
	delivery: (config: AppConfigService) => D,
) =>
	Layer.unwrap(
		Effect.map(AppConfig, (config) => {
			const persistence = PersistenceLive.layer(config);
			const application = Layer.provideMerge(DomainLive.layer, persistence);
			return Layer.provide(
				RuntimeLive.layer(config, delivery(config)),
				application,
			);
		}),
	);
