import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { NotificationRecipients } from '../../src/ports/NotificationRecipients.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	PostgresTestLayer.layer,
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
if (!enabled)
	describe.skip('notification recipients PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('notification recipients PostgreSQL', () => {
		it('resolves owner private chat or an audited unreachable result', async () => {
			const program = Effect.gen(function* () {
				const telegramId = Math.floor(Math.random() * 1_000_000_000) + 1;
				const users = yield* UserRepository;
				const registered = yield* users.registerTelegramProfile({
					botId,
					telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
					username: null,
					firstName: 'Reachable',
					lastName: null,
					privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
				});
				const missingId = Schema.decodeUnknownSync(UserId)(crypto.randomUUID());
				const sql = yield* PgClient.PgClient;
				yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${missingId}::uuid,now(),now())`;
				const recipients = yield* NotificationRecipients;
				return {
					reachable: yield* recipients.resolveOwner(botId, registered.user.id),
					unreachable: yield* recipients.resolveOwner(botId, missingId),
				};
			});
			const result = await Effect.runPromise(Effect.provide(program, layer));
			expect(result.reachable).toMatchObject({
				_tag: 'Reachable',
				channel: 'telegram',
			});
			expect(result.unreachable).toMatchObject({
				_tag: 'Unreachable',
				error: { code: 'MissingTelegramIdentity' },
			});
		});
	});
