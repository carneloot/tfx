import * as Context from 'effect/Context';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Scope from 'effect/Scope';
import * as TestClock from 'effect/testing/TestClock';

import type * as Bot from '../../src/Bot.js';
import * as BotRuntimeLive from '../../src/BotRuntime.js';
import type { DispatchOutcome } from '../../src/DispatchOutcome.js';
import type { Update } from '../../src/internal/telegram/generated/TelegramApi.types.js';
import * as MemoryConversationStorage from '../../src/MemoryConversationStorage.js';
import * as MemoryUpdateDeduplicator from '../../src/MemoryUpdateDeduplicator.js';
import * as FakeTelegram from './FakeTelegram.js';
import * as InMemoryDelivery from './InMemoryDelivery.js';
import { RecordedRequests } from './RecordedRequests.js';
export interface TestBot {
	readonly send: (update: Update) => Effect.Effect<DispatchOutcome>;
	readonly requests: RecordedRequests['Service'];
	readonly advance: (duration: Duration.Input) => Effect.Effect<void>;
	readonly shutdown: Effect.Effect<void>;
}
export const make = (
	bot: Bot.Bot<any, any>,
	script: ReadonlyArray<FakeTelegram.Script> = [],
): Effect.Effect<TestBot, never, Scope.Scope> =>
	Effect.gen(function* () {
		const memory = yield* InMemoryDelivery.make();
		const runtime = Layer.provide(
			BotRuntimeLive.layer(bot, { delivery: memory.delivery }),
			MemoryUpdateDeduplicator.layerMemory,
		);
		const context = yield* Layer.build(
			Layer.mergeAll(
				runtime,
				FakeTelegram.layer(script),
				MemoryConversationStorage.layer,
				TestClock.layer(),
			),
		);
		const requests = Context.get(context, RecordedRequests);
		return {
			send: (update) =>
				Effect.andThen(
					memory.offer(update),
					memory.awaitOutcome(update.update_id),
				),
			requests,
			advance: (duration) =>
				Effect.provide(TestClock.adjust(duration), context),
			shutdown: memory.close,
		};
	});
