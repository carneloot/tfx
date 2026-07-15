import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';

import type * as Bot from '../../src/Bot.js';
import type { Update } from '../../src/internal/telegram/generated/TelegramApi.types.js';
import type * as FakeTelegram from './FakeTelegram.js';
import * as TestBot from './TestBot.js';
export interface Scenario {
	readonly start: Update;
	readonly steps?: ReadonlyArray<Update>;
	readonly duplicate?: ReadonlyArray<number>;
	readonly advance?: Duration.Input;
	readonly script?: ReadonlyArray<FakeTelegram.Script>;
	readonly expectMethods?: ReadonlyArray<string>;
}
export const run = (bot: Bot.Bot<any, any>, scenario: Scenario) =>
	Effect.scoped(
		Effect.gen(function* () {
			const harness = yield* TestBot.make(bot, scenario.script);
			const updates = [scenario.start, ...(scenario.steps ?? [])];
			for (const update of updates) {
				yield* harness.send(update);
				if (scenario.duplicate?.includes(update.update_id))
					yield* harness.send(update);
			}
			if (scenario.advance !== undefined)
				yield* harness.advance(scenario.advance);
			const requests = yield* harness.requests.all;
			if (scenario.expectMethods !== undefined) {
				const actual = requests.map((request) => request.method);
				if (actual.join('\0') !== scenario.expectMethods.join('\0'))
					return yield* Effect.die(
						new Error(
							`Expected requests ${scenario.expectMethods.join(', ')}, received ${actual.join(', ')}`,
						),
					);
			}
			yield* harness.shutdown;
			return requests;
		}),
	);
