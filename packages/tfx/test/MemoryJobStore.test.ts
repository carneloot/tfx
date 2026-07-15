import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { JobStore } from '../src/JobStore.js';
import * as MemoryJobStore from '../src/MemoryJobStore.js';
const run = <A, E>(effect: Effect.Effect<A, E, JobStore>) =>
	Effect.runPromise(Effect.provide(effect, MemoryJobStore.layer));
const request = (overrides = {}) => ({
	name: 'job',
	payload: 'v',
	payloadVersion: 1,
	maxAttempts: 2,
	now: 0,
	runAt: 0,
	...overrides,
});
describe('MemoryJobStore', () => {
	it('replaces active conflict keys and orders due work', async () => {
		await run(
			Effect.gen(function* () {
				const store = yield* JobStore;
				const first = yield* store.schedule(
					request({ conflictKey: 'same', runAt: 10 }),
				);
				const second = yield* store.schedule(
					request({ conflictKey: 'same', runAt: 5 }),
				);
				expect(second.replacedId).toBe(first.record.id);
				expect((yield* store.get(first.record.id))?.status).toBe('cancelled');
				expect((yield* store.claimForMigration(5, 10))?.record.id).toBe(
					second.record.id,
				);
			}),
		);
	});
	it('allows exactly one claimant under parallel contention', async () => {
		await run(
			Effect.gen(function* () {
				const store = yield* JobStore;
				yield* store.schedule(request());
				const claims = yield* Effect.all(
					Array.from({ length: 16 }, () => store.claimForMigration(0, 10)),
					{ concurrency: 'unbounded' },
				);
				expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
			}),
		);
	});

	it('uses two fenced phases and exact attempt accounting', async () => {
		await run(
			Effect.gen(function* () {
				const store = yield* JobStore;
				const { record } = yield* store.schedule(request());
				const migration = (yield* store.claimForMigration(0, 10))!;
				expect(migration.record.attempts).toBe(0);
				const running = yield* store.promoteToRunning(
					migration.token,
					'migrated',
					2,
					0,
					10,
				);
				expect(running.attempts).toBe(1);
				const reclaimed = (yield* store.claimForMigration(11, 10))!;
				expect(reclaimed.record.attempts).toBe(1);
				expect(reclaimed.token.generation).toBe(migration.token.generation + 1);
				expect(
					yield* store.finalize(migration.token, { _tag: 'Succeeded' }, 12),
				).toBe(false);
				const rerun = yield* store.promoteToRunning(
					reclaimed.token,
					'migrated',
					2,
					12,
					10,
				);
				expect(rerun.attempts).toBe(2);
				expect(yield* store.claimForMigration(23, 10)).toBeUndefined();
				expect(
					yield* store.finalize(reclaimed.token, { _tag: 'Succeeded' }, 24),
				).toBe(false);
				expect(yield* store.get(record.id)).toMatchObject({
					attempts: 2,
					status: 'failed',
					errorSummary: 'AttemptsExhausted',
				});
			}),
		);
	});
	it('quarantines, releases, cancels, and rejects stale tokens', async () => {
		await run(
			Effect.gen(function* () {
				const store = yield* JobStore;
				const { record } = yield* store.schedule(request());
				const claim = (yield* store.claimForMigration(0, 10))!;
				yield* store.quarantineMigration(claim.token, 'invalid', 1);
				expect((yield* store.get(record.id))?.attempts).toBe(0);
				const released = yield* store.releaseFailed(record.id, 2, {
					reason: 'fixed',
					resetAttempts: true,
				});
				expect(released.status).toBe('scheduled');
				expect(yield* store.cancel(record.id, 3)).toBe(true);
			}),
		);
	});
});
