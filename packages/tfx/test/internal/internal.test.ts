import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Bot } from '../../src/index.js';
import * as MemoryConversationStorage from '../../src/MemoryConversationStorage.js';
import * as MemoryJobStore from '../../src/MemoryJobStore.js';
import * as MemoryUpdateDeduplicator from '../../src/MemoryUpdateDeduplicator.js';
import { Telegram } from '../../src/Telegram.js';
import * as TelegramSchemas from '../../src/TelegramSchemas.js';
import * as ConversationScenario from './ConversationScenario.js';
import { conversationStorageConformance } from './ConversationStorageConformance.js';
import { deduplicatorConformance } from './DeduplicatorConformance.js';
import * as FakeTelegram from './FakeTelegram.js';
import { jobStoreConformance } from './JobStoreConformance.js';
import { RecordedRequests } from './RecordedRequests.js';
import * as TestBot from './TestBot.js';
import * as UpdateFixtures from './UpdateFixtures.js';
describe('private tfx harness', () => {
	it('records FIFO requests, method lookup/count, scripts, and consumption', async () => {
		const program = Effect.gen(function* () {
			const telegram = yield* Telegram;
			const recorded = yield* RecordedRequests;
			yield* telegram.sendMessage({ chat_id: 1, text: 'safe' });
			yield* telegram.getMe();
			expect(yield* recorded.count()).toBe(2);
			expect(yield* recorded.count('sendMessage')).toBe(1);
			expect((yield* recorded.all).map((request) => request.method)).toEqual([
				'sendMessage',
				'getMe',
			]);
			expect(JSON.stringify(yield* recorded.all)).not.toContain('bot-token');
			yield* recorded.assertConsumed;
		});
		await Effect.runPromise(
			Effect.provide(
				program,
				FakeTelegram.layer([
					FakeTelegram.succeed('sendMessage', { message_id: 1 }),
					FakeTelegram.succeed('getMe', { id: 1 }),
				]),
			),
		);
	});
	it('detects unconsumed scripts', async () => {
		const program = Effect.flatMap(
			RecordedRequests,
			(requests) => requests.assertConsumed,
		);
		await expect(
			Effect.runPromise(
				Effect.provide(
					program,
					FakeTelegram.layer([FakeTelegram.succeed('getMe', {})]),
				),
			),
		).rejects.toThrow('Unconsumed');
	});
	it('builds schema-valid deterministic update fixtures', () => {
		const fixtures = [
			UpdateFixtures.command('start'),
			UpdateFixtures.text('hello'),
			UpdateFixtures.callback('data', { withMessage: false }),
			UpdateFixtures.reaction('👍'),
			UpdateFixtures.inline('query'),
			UpdateFixtures.channel('post'),
			UpdateFixtures.business('business'),
		];
		expect(UpdateFixtures.callback('data').callback_query).toHaveProperty(
			'message',
		);
		for (const fixture of fixtures)
			expect(() =>
				Schema.decodeUnknownSync(
					TelegramSchemas.Update as unknown as Schema.ConstraintDecoder<
						unknown,
						never
					>,
				)(fixture),
			).not.toThrow();
	});
	it('runs controlled in-memory delivery and scenario helpers', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const harness = yield* TestBot.make(Bot.make('test'));
					expect(yield* harness.send(UpdateFixtures.text('hello'))).toEqual({
						_tag: 'Handled',
					});
					yield* harness.shutdown;
				}),
			),
		);
		await Effect.runPromise(
			ConversationScenario.run(Bot.make('scenario'), {
				start: UpdateFixtures.command('start'),
				expectMethods: [],
			}),
		);
	});
});
conversationStorageConformance('memory', () => MemoryConversationStorage.layer);
jobStoreConformance('memory', () => MemoryJobStore.layer);
deduplicatorConformance('memory', () => MemoryUpdateDeduplicator.layerMemory);
