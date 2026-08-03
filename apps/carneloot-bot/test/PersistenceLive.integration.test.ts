import { Effect, Layer } from 'effect';
import { ConversationStorage } from 'tfx/ConversationStorage';
import { JobStore } from 'tfx/JobStore';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../src/Config.js';
import * as PersistenceLive from '../src/PersistenceLive.js';
import { NotificationRecipients } from '../src/ports/NotificationRecipients.js';
import { NotificationRepository } from '../src/ports/NotificationRepository.js';
import { PetCaregiverRepository } from '../src/ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../src/ports/PetFoodRepository.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import * as DeterministicCrypto from './internal/DeterministicCrypto.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
import { testConfig } from './internal/TestConfig.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('application persistence layer', () => {
	it('acquires both migrated persistence suites', async () => {
		const config: AppConfigService = {
			...testConfig,
			tfxSchema: 'tfx_persistence_stage',
			tfxTablePrefix: 'case_',
		};
		const graph = Layer.provide(
			PersistenceLive.layer(config),
			Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.flatMap(Layer.build(graph), (context) =>
					Effect.provide(
						Effect.gen(function* () {
							yield* ConversationStorage;
							yield* JobStore;
							yield* UpdateDeduplicator;
							yield* UserRepository;
							yield* PetRepository;
							yield* PetCaregiverRepository;
							yield* PetFoodRepository;
							yield* NotificationRepository;
							yield* NotificationRecipients;
						}),
						context,
					),
				),
			),
		);
		expect(true).toBe(true);
	});
});
