import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Telegram from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../src/Config.js';
import * as Layers from '../src/Layers.js';
import * as Router from '../src/Router.js';

const config: AppConfigService = {
	botToken: Redacted.make('test'),
	databaseUrl: Redacted.make('postgres://unused'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeoutSeconds: 30,
	pollingRetryMillis: 100,
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdleMillis: 100,
	jobLeaseMillis: 30_000,
	dedupLeaseMillis: 30_000,
	dedupWaitMillis: 1_000,
	dedupRetentionMillis: 86_400_000,
	tfxSchema: 'tfx',
	tfxTablePrefix: 'smoke_',
};
describe('portable Node composition', () => {
	it('constructs the portable graph without network or private imports', () => {
		const telegram = Layer.provide(
			Telegram.layer(config.botToken),
			NodeHttpClient.layerFetch,
		);
		const graph = Layers.portable(config, {
			pg: PgClient.layer({ url: config.databaseUrl }),
			telegram,
			delivery: UpdateDelivery.manual,
			botUsername: config.botUsername,
		});
		expect(graph).toBeDefined();
		expect(Router.accountHandlers.entries).toHaveLength(1);
		expect(Router.petHandlers.entries).toHaveLength(2);
		expect(Router.petFoodHandlers.entries).toHaveLength(4);
		expect(Router.conversations).toHaveLength(4);
	});
});
