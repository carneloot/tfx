import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';

const decode = Schema.decodeUnknownSync(FoodAmount);
describe('FoodAmount', () => {
	it.each([
		['50', 50_000],
		['50g', 50_000],
		['50000mg', 50_000],
		['0.05kg', 50_000],
		['0.001g', 1],
		['100kg', 100_000_000],
	] as const)('decodes %s exactly', (input, expected) => {
		expect(decode(input)).toBe(expected);
	});
	it.each([
		'0',
		'-1g',
		'0.0001g',
		'100.000001kg',
		'1e3g',
		'NaN',
		'Infinity',
		'1lb',
		'1.2.3g',
	])('rejects %s', (input) => {
		expect(() => decode(input)).toThrow();
	});
	it('encodes a canonical integer milligram representation', () => {
		expect(Schema.encodeSync(FoodAmount)(50_000 as never)).toBe('50000mg');
	});
});
