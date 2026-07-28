import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	legacyId,
	LegacyIdNamespace,
	sourceFingerprint,
} from '../../src/importer/LegacyId.js';

const layers = [
	['Node', NodeCrypto.layer],
	['Bun', BunCrypto.layer],
] as const;

const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
	Effect.runPromise(effect);

for (const [runtime, layer] of layers) {
	describe(`${runtime} Crypto layer`, () => {
		it('matches fixed source fingerprint and UUIDv5 vectors', async () => {
			const result = await run(
				Effect.gen(function* () {
					const fingerprint = yield* sourceFingerprint('source-a');
					const id = yield* legacyId(fingerprint, 'users', '42');
					return { fingerprint, id };
				}).pipe(Effect.provide(layer)),
			);

			expect(LegacyIdNamespace).toBe('7d4f55c8-2f1d-5b6c-9a3e-8b4f1e7c2d90');
			expect(result).toEqual({
				fingerprint:
					'sha256:e732bf14dac3352e4253712da1dcda5e5d94c4bd492622c9aedf86a98403b576',
				id: '33ab847b-2e5a-53e7-bfbb-a1a606a188d5',
			});
		});

		it('is stable and separates tables and source fingerprints', async () => {
			const ids = await run(
				Effect.gen(function* () {
					const sourceA = yield* sourceFingerprint('source-a');
					const sourceB = yield* sourceFingerprint('source-b');
					return yield* Effect.all([
						legacyId(sourceA, 'users', '42'),
						legacyId(sourceA, 'users', '42'),
						legacyId(sourceA, 'pets', '42'),
						legacyId(sourceB, 'users', '42'),
					]);
				}).pipe(Effect.provide(layer)),
			);

			expect(ids).toEqual([
				'33ab847b-2e5a-53e7-bfbb-a1a606a188d5',
				'33ab847b-2e5a-53e7-bfbb-a1a606a188d5',
				'10a13721-f422-5864-a427-46f479e78ba2',
				'2833fca5-0acf-5788-8eba-146b577e543f',
			]);
			expect(new Set(ids).size).toBe(3);
		});

		it('sets RFC 4122 version 5 and variant bits', async () => {
			const id = await run(
				legacyId('sha256:test', 'table', 'key').pipe(Effect.provide(layer)),
			);
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		});
	});
}
