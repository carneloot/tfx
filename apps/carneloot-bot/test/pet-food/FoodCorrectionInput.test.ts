import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import { parse } from '../../src/domain/pet-food/FoodCorrectionInput.js';

const run = (input: string) => Effect.runPromise(parse(input));

describe('FoodCorrectionInput', () => {
	it.each([
		['50', { amountMg: 50_000 }],
		['50g', { amountMg: 50_000 }],
		['50000mg', { amountMg: 50_000 }],
		['0.05kg', { amountMg: 50_000 }],
		['08:30', { when: '08:30' }],
		['14/07 08:30', { when: '14/07 08:30' }],
		['50g 08:30', { amountMg: 50_000, when: '08:30' }],
		['50g 14/07 08:30', { amountMg: 50_000, when: '14/07 08:30' }],
	] as const)('parses %s', async (input, expected) => {
		expect(await run(input)).toEqual(expected);
	});

	it.each([
		'',
		'food',
		'50watts',
		'14/07',
		'8:30',
		'50g 14/07',
		'50g 60g',
		'50g 08:30 extra',
	])('rejects malformed correction: %s', async (input) => {
		await expect(run(input)).rejects.toMatchObject({
			_tag: 'InvalidDomainInput',
		});
	});
});
