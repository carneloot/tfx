import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import { build } from 'esbuild';
import {
	Miniflare,
	type Request as MockRequest,
	Response as MockResponse,
} from 'miniflare';
import { describe, expect, it } from 'vitest';

import * as GenerateApiKey from '../../src/application/GenerateApiKey.js';
import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

// Real workerd + Hyperdrive TCP requires an explicit local test database URL.
const enabled = process.env.TEST_DATABASE_URL !== undefined;
describe.skipIf(!enabled)(
	'notification HttpApi on workerd and PostgreSQL',
	() => {
		it('dispatches through per-event application graph, codecs and Telegram HTTP, preserving partial/unknown outcomes', async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const botId = Schema.decodeUnknownSync(BotId)('carneloot');
					const users = yield* UserRepository;
					const sql = yield* PgClient.PgClient;
					const owner = yield* users.registerTelegramProfile({
						botId,
						telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(7001),
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(7001),
						firstName: 'Owner',
						lastName: null,
						username: null,
					});
					const subscriber = yield* users.registerTelegramProfile({
						botId,
						telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(7002),
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(7002),
						firstName: 'Subscriber',
						lastName: null,
						username: null,
					});
					const templateId = crypto.randomUUID();
					yield* sql`INSERT INTO carneloot.api_keys VALUES (${crypto.randomUUID()}::uuid,${owner.user.id}::uuid,${yield* GenerateApiKey.hash('workerd-key')},now(),now())`;
					yield* sql`INSERT INTO carneloot.notification_templates VALUES (${templateId}::uuid,${owner.user.id}::uuid,'alarm','Hello {{pet}}, {{pet}}!',now(),now())`;
					yield* sql`INSERT INTO carneloot.notification_subscriptions VALUES (${templateId}::uuid,${subscriber.user.id}::uuid,now())`;
					const result = yield* Effect.promise(() =>
						build({
							entryPoints: [
								'apps/carneloot-bot/test/cloudflare/NotificationWorker.ts',
							],
							bundle: true,
							write: false,
							format: 'esm',
							platform: 'node',
							target: 'es2024',
							external: ['node:*'],
						}),
					);
					const script = result.outputFiles[0]?.text;
					if (script === undefined) return yield* Effect.die('missing bundle');
					let sends = 0;
					let mode: 'sent' | 'failed' | 'unknown' = 'sent';
					const emulator = new Miniflare({
						modules: true,
						script,
						compatibilityDate: '2026-07-30',
						compatibilityFlags: ['nodejs_compat'],
						hyperdrives: { HYPERDRIVE: process.env.TEST_DATABASE_URL },
						bindings: {
							BOT_TOKEN: 'test-token',
							BOT_USERNAME: 'carneloot_bot',
							TFX_POSTGRES_SCHEMA: 'tfx_notifications_workerd_test',
							TFX_POSTGRES_TABLE_PREFIX: 'bot_',
						},
						outboundService: async (request: MockRequest) => {
							expect(new URL(request.url).origin).toBe(
								'https://api.telegram.org',
							);
							sends++;
							const payload = Schema.decodeUnknownSync(
								Schema.Struct({ chat_id: Schema.Number, text: Schema.String }),
							)(await request.json());
							expect(payload.text).toBe('Hello Milo, Milo!');
							if (mode === 'unknown') return new MockResponse('not JSON');
							if (mode === 'failed' && payload.chat_id === 7002)
								return MockResponse.json(
									{ ok: false, error_code: 403, description: 'Forbidden' },
									{ status: 403 },
								);
							return MockResponse.json({
								ok: true,
								result: {
									message_id: sends,
									date: 100,
									chat: { id: payload.chat_id, type: 'private' },
									text: payload.text,
								},
							});
						},
					});
					try {
						for (const [nextMode, status, counts] of [
							['sent', 200, { sent: 2, failed: 0, unknown: 0 }],
							['failed', 207, { sent: 1, failed: 1, unknown: 0 }],
							['unknown', 202, { sent: 0, failed: 0, unknown: 2 }],
						] as const) {
							mode = nextMode;
							const response = yield* Effect.promise(() =>
								emulator.dispatchFetch('https://bot.test/api/notify', {
									method: 'POST',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										apiKey: 'workerd-key',
										keyword: 'alarm',
										variables: { pet: 'Milo' },
									}),
								}),
							);
							expect(response.status).toBe(status);
							expect(
								yield* Effect.promise(() => response.json()),
							).toMatchObject({ counts });
						}
						expect(sends).toBe(6);
					} finally {
						yield* Effect.promise(() => emulator.dispose());
					}
				}).pipe(
					Effect.provide(
						Layer.provideMerge(
							RepositoriesLive.layer,
							Layer.merge(PostgresTestLayer.layer, NodeCrypto.layer),
						),
					),
				),
			);
		}, 60_000);
	},
);
