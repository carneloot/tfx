import * as Layer from 'effect/Layer';
import { describe, it } from 'vitest';

import { conversationStorageConformance } from '../../tfx/test/internal/ConversationStorageConformance.js';
import * as PostgresConversationStorage from '../src/PostgresConversationStorage.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (!enabled)
	describe.skip('PostgreSQL conversation conformance', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	conversationStorageConformance(
		'postgres',
		() =>
			Layer.provide(
				PostgresConversationStorage.layer({
					schema: 'tfx_conversation_test',
					tablePrefix: 'case_',
				}),
				PostgresTestLayer.layer,
			),
		{ durableRestart: true, multiProcess: true },
	);
