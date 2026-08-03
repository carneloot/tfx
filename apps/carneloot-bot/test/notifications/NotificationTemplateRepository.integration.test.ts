import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { UserId } from '../../src/domain/Ids.js';
import { NotificationKeyword } from '../../src/domain/notifications/NotificationTemplate.js';
import { NotificationTemplateRepository } from '../../src/ports/NotificationTemplateRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
);
const id = (value: string) => Schema.decodeUnknownSync(UserId)(value);
const keyword = Schema.decodeUnknownSync(NotificationKeyword)('alerta');

if (!enabled)
	describe.skip('notification template PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('notification template PostgreSQL', () => {
		it('isolates owner and keyword while loading subscribers', async () => {
			const owner = id('00000000-0000-4000-8000-000000002001');
			const subscriber = id('00000000-0000-4000-8000-000000002002');
			const otherOwner = id('00000000-0000-4000-8000-000000002003');
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient;
						yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${owner}::uuid,now(),now()),(${subscriber}::uuid,now(),now()),(${otherOwner}::uuid,now(),now())`;
						yield* sql`INSERT INTO carneloot.notification_templates (id,owner_user_id,keyword,message,created_at,updated_at) VALUES ('00000000-0000-4000-8000-000000002011',${owner}::uuid,${keyword},'Alerta',now(),now()),('00000000-0000-4000-8000-000000002012',${otherOwner}::uuid,${keyword},'Outro',now(),now())`;
						yield* sql`INSERT INTO carneloot.notification_subscriptions (template_id,user_id,created_at) VALUES ('00000000-0000-4000-8000-000000002011',${subscriber}::uuid,now())`;
						const repository = yield* NotificationTemplateRepository;
						return yield* repository.findByOwnerAndKeyword(owner, keyword);
					}),
					layer,
				),
			);
			expect(result).toMatchObject({
				template: { ownerUserId: owner, message: 'Alerta' },
				subscriberUserIds: [subscriber],
			});
		});
	});
