import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	mapLegacySnapshot,
	updateIdFromDigest,
} from '../../src/importer/LegacyMapping.js';
import {
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
const empty = () =>
	Object.fromEntries(
		legacyTables.map((t) => [t, []]),
	) as unknown as LegacySnapshot;
describe('legacy mapping', () => {
	it('uses all first 53 digest bits without 32-bit truncation', () => {
		expect(
			updateIdFromDigest(Uint8Array.from([255, 255, 255, 255, 255, 255, 248])),
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			updateIdFromDigest(Uint8Array.from([1, 2, 3, 4, 5, 6, 248])),
		).toBeGreaterThan(0xffffffff);
	});
	it('preserves food timestamp and reports exact rounding', async () => {
		const snapshot = empty() as any;
		snapshot.users = [
			{
				id: 'u',
				telegram_id: '42',
				username: null,
				first_name: 'A',
				last_name: null,
			},
		];
		snapshot.pets = [{ id: 'p', name: 'Pet', owner_id: 'u' }];
		snapshot.pet_food = [
			{
				id: 'f',
				pet_id: 'p',
				user_id: 'u',
				message_id: 7,
				quantity: 1.2345,
				time: 1700000000,
			},
		];
		const mapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				'sha256:test',
				'bot',
				new Date('2026-01-01'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const food = mapped.rows.find(
			(r) => r.targetTable === 'pet_food_entries',
		)!.value;
		expect(food.amount_mg).toBe(1235);
		expect(food.fed_at).toBe('2023-11-14T22:13:20.000Z');
		expect(mapped.rounding[0]?.deltaMg).toBeCloseTo(0.5);
		expect(food.source_message_chat_id).toBe(42);
	});
});
