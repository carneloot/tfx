import { describe, expect, it } from 'vitest';

import { makeCursor, sweep } from '../src/internal/BoundedMapSweep.js';

describe('BoundedMapSweep', () => {
	it('resumes after the previous batch instead of rescanning the head', () => {
		const rows = new Map(
			Array.from(
				{ length: 20 },
				(_, index) => [index, { expired: index >= 16 }] as const,
			),
		);
		const cursor = makeCursor<number, { readonly expired: boolean }>();
		sweep(rows, cursor, (row) => row.expired, 16);
		expect(rows.size).toBe(20);
		sweep(rows, cursor, (row) => row.expired, 16);
		expect([...rows.keys()]).toEqual(
			Array.from({ length: 16 }, (_, index) => index),
		);
	});
});
