import * as Schema from 'effect/Schema';

const FoodWhenPattern =
	/^(?:\d{2}:\d{2}|\d{2}\/\d{2}(?:\/\d{4})? \d{2}:\d{2}|\d{2}-\d{2}(?:-\d{4})? \d{2}:\d{2})$/u;

/** Validates supported raw food timestamp syntax without interpreting it. */
export const FoodWhenInput = Schema.String.check(
	Schema.isPattern(FoodWhenPattern, {
		message: 'Expected HH:mm or DD/MM[/YYYY] HH:mm',
	}),
);
export type FoodWhenInput = typeof FoodWhenInput.Type;
