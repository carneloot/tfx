import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { CommandInput } from 'tfx';
import { describe, expect, it } from 'vitest';

import { parse } from '../../../../packages/tfx/src/internal/bot/CommandParser.js';
import { addFoodToAll, AddFoodToAllInput } from '../../src/bot/Declaration.js';
import type { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Assert<T extends true> = T;
type AddFoodToAllDecoded = CommandInput.Decoded<typeof AddFoodToAllInput>;
type _AddFoodToAllInputIsExact = Assert<
	Equal<
		AddFoodToAllDecoded,
		{ readonly amount: FoodAmount; readonly when?: string }
	>
>;

// Text command leaves must decode from strings.
// @ts-expect-error Schema.Number accepts numbers rather than command text.
CommandInput.argument('amount', Schema.Number);

describe('addFoodToAll declaration', () => {
	it('uses one canonical command and the todos alias', () => {
		expect(addFoodToAll.id).toBe('addFoodToAll');
		expect(addFoodToAll.name).toBe('colocar_racao_todos');
		expect(addFoodToAll.aliases).toEqual(['todos']);
		expect(addFoodToAll.input).toBe(AddFoodToAllInput);
	});

	it('parses typed amount followed by optional rest time', async () => {
		await expect(
			Effect.runPromise(parse(AddFoodToAllInput, '1.5kg')),
		).resolves.toEqual({ amount: 1_500_000 });
		await expect(
			Effect.runPromise(parse(AddFoodToAllInput, '50g 16/07/2026 08:30')),
		).resolves.toEqual({ amount: 50_000, when: '16/07/2026 08:30' });
	});

	it('rejects missing amount and malformed time', async () => {
		await expect(
			Effect.runPromise(parse(AddFoodToAllInput, '')),
		).rejects.toThrow();
		await expect(
			Effect.runPromise(parse(AddFoodToAllInput, '50g tomorrow morning')),
		).rejects.toThrow();
	});
});
