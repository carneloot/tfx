import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { JobStore } from '../../src/JobStore.js';
import type { Capabilities } from './ConversationStorageConformance.js';
export const jobStoreConformance = (
	name: string,
	storeLayer: () => Layer.Layer<JobStore, unknown, never>,
	capabilities: Capabilities = {},
) =>
	describe(`${name} JobStore conformance`, () => {
		const run = <A, E>(effect: Effect.Effect<A, E, JobStore>) =>
			Effect.runPromise(Effect.provide(effect, storeLayer()));
		it('schedule, conflict, two-phase accounting, heartbeat, stale fence, quarantine, and release', async () =>
			run(
				Effect.gen(function* () {
					const store = yield* JobStore;
					const request = {
						name: 'job',
						payload: 'old',
						payloadVersion: 1,
						maxAttempts: 2,
						runAt: 0,
						now: 0,
						conflictKey: `${name}-key`,
					};
					const first = yield* store.schedule(request);
					const second = yield* store.schedule(request);
					expect(second.replacedId).toBe(first.record.id);
					const claim = (yield* store.claimForMigration(0, 10))!;
					expect(claim.record.attempts).toBe(0);
					const running = yield* store.promoteToRunning(
						claim.token,
						'new',
						2,
						0,
						10,
					);
					expect(running.attempts).toBe(1);
					expect(yield* store.heartbeat(claim.token, 1, 10)).toBe(true);
					const takeover = (yield* store.claimForMigration(12, 10))!;
					expect(takeover.token.generation).toBe(claim.token.generation + 1);
					expect(
						yield* store.finalize(claim.token, { _tag: 'Succeeded' }, 13),
					).toBe(false);
					yield* store.quarantineMigration(takeover.token, 'invalid', 13);
					expect(
						(yield* store.releaseFailed(running.id, 14, {
							reason: 'fixed',
							resetAttempts: true,
						})).attempts,
					).toBe(0);
				}),
			));
		it.skipIf(!capabilities.multiProcess)(
			'fences multiple processes',
			() => {},
		);
	});
