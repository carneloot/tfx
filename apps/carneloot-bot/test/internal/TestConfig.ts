import * as Duration from 'effect/Duration';
import * as Redacted from 'effect/Redacted';

import type { AppConfigService } from '../../src/Config.js';

export const testConfig = {
	botToken: Redacted.make('test'),
	databaseUrl: Redacted.make('postgres://unused'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeout: Duration.seconds(30),
	pollingRetryDelay: Duration.millis(100),
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdle: Duration.millis(100),
	jobLease: Duration.seconds(30),
	jobHeartbeat: Duration.seconds(10),
	dedupLease: Duration.seconds(30),
	dedupHeartbeat: Duration.seconds(10),
	dedupWait: Duration.seconds(1),
	dedupRetention: Duration.days(1),
	tfxSchema: 'tfx_test',
	tfxTablePrefix: 'case_',
} satisfies AppConfigService;
