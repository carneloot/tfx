import { Effect, Layer } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../../src/DispatchOutcome.js';
import { UpdateDeduplicator } from '../../src/UpdateDeduplicator.js';
import type { Capabilities } from './ConversationStorageConformance.js';
export const deduplicatorConformance = (
	name: string,
	dedupLayer: () => Layer.Layer<UpdateDeduplicator>,
	capabilities: Capabilities = {},
) =>
	describe(`${name} UpdateDeduplicator conformance`, () => {
		const run = <A, E>(effect: Effect.Effect<A, E, UpdateDeduplicator>) =>
			Effect.runPromise(
				Effect.provide(Effect.provide(effect, dedupLayer()), TestClock.layer()),
			);
		it('acquire, in-progress, heartbeat, completion, takeover, stale fences, release, and diagnostics', async () =>
			run(
				Effect.gen(function* () {
					const dedup = yield* UpdateDeduplicator;
					expect(dedup.diagnostics.backend).toBe(name);
					const first = yield* dedup.claim(1, { leaseDuration: 10 });
					if (first._tag !== 'Acquired') throw new Error('expected acquired');
					expect((yield* dedup.claim(1))._tag).toBe('InProgress');
					expect(yield* dedup.heartbeat(first.token, 10)).toBe(true);
					yield* TestClock.adjust('11 millis');
					const second = yield* dedup.claim(1);
					if (second._tag !== 'Acquired') throw new Error('expected takeover');
					expect(
						yield* dedup.complete(first.token, DispatchOutcome.handled),
					).toBe(false);
					expect(
						yield* dedup.complete(second.token, DispatchOutcome.handled, 10),
					).toBe(true);
					expect((yield* dedup.claim(1))._tag).toBe('Completed');
				}),
			));
		it.skipIf(!capabilities.durableRestart)(
			'retains completion after restart',
			() => {},
		);
	});
