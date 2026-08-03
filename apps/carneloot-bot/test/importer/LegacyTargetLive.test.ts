import { describe, expect, it } from 'vitest';

import {
	normalizeMappedForComparison,
	normalizeTargetForComparison,
} from '../../src/importer/LegacyTargetLive.js';

describe('normalizeTargetForComparison', () => {
	it('normalizes mapped timestamps to ISO instants', () => {
		const result = normalizeTargetForComparison(
			{
				created_at: '2026-01-01T00:00:00.000Z',
				message: 'Hello',
			},
			{
				created_at: '2025-12-31T21:00:00-03:00',
				message: 'Hello',
			},
		);

		expect(result).toEqual({
			created_at: '2026-01-01T00:00:00.000Z',
			message: 'Hello',
		});
	});

	it('compares mapped UTC milliseconds and target UTC offset equally', () => {
		const mapped = { created_at: '2026-01-01T00:00:00.000Z' };
		const target = { created_at: '2026-01-01T00:00:00+00:00' };

		expect(normalizeMappedForComparison(mapped)).toEqual(
			normalizeTargetForComparison(mapped, target),
		);
	});

	it('preserves non-timestamp values exactly', () => {
		const result = normalizeTargetForComparison(
			{ message: '2026-01-01T00:00:00.000Z' },
			{ message: '2025-12-31T21:00:00-03:00' },
		);

		expect(result).toEqual({ message: '2025-12-31T21:00:00-03:00' });
	});
});
