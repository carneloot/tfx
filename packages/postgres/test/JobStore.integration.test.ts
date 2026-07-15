import * as Layer from 'effect/Layer';
import { describe, it } from 'vitest';

import { jobStoreConformance } from '../../tfx/test/internal/JobStoreConformance.js';
import * as PostgresJobStore from '../src/PostgresJobStore.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (!enabled)
	describe.skip('PostgreSQL job conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	jobStoreConformance(
		'postgres',
		() =>
			Layer.provide(
				PostgresJobStore.layer({
					schema: 'tfx_job_test',
					tablePrefix: 'case_',
				}),
				PostgresTestLayer.layer,
			),
		{ durableRestart: true, multiProcess: true },
	);
