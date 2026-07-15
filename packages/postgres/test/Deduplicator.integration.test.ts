import * as Layer from 'effect/Layer';
import { describe, it } from 'vitest';

import { deduplicatorConformance } from '../../tfx/test/internal/DeduplicatorConformance.js';
import * as PostgresUpdateDeduplicator from '../src/PostgresUpdateDeduplicator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (!enabled)
	describe.skip('PostgreSQL dedup conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	deduplicatorConformance(
		'postgres',
		() =>
			Layer.provide(
				PostgresUpdateDeduplicator.layer({
					schema: 'tfx_dedup_test',
					tablePrefix: 'case_',
					botId: 'test',
				}),
				PostgresTestLayer.layer,
			),
		{ durableRestart: true, multiProcess: true },
	);
