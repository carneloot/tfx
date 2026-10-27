import * as Schema from 'effect/Schema';

const foodWhenSyntax = String.raw`(?:-\d+min|\d{2}:\d{2}|\d{2}\/\d{2}(?:\/\d{4})? \d{2}:\d{2}|\d{2}-\d{2}(?:-\d{4})? \d{2}:\d{2})`;
const FoodWhenPattern = new RegExp(`^${foodWhenSyntax}$`, 'iu');
const foodSuffix = new RegExp(`^(.*?\\S)\\s+(${foodWhenSyntax})$`, 'iu');

/** Validates supported raw food timestamp syntax without interpreting it. */
export const FoodWhenInput = Schema.String.check(
	Schema.isPattern(FoodWhenPattern, {
		message: 'Expected -Nmin, HH:mm or DD/MM[/YYYY] HH:mm',
	}),
);
export type FoodWhenInput = typeof FoodWhenInput.Type;

/** Leaves malformed suffixes in the amount so amount decoding rejects them. */
export const splitAmountAndWhen = (input: string) => {
	const trimmed = input.trim();
	if (trimmed.length === 0) return undefined;
	const suffix = foodSuffix.exec(trimmed);
	return suffix?.[1] !== undefined && suffix[2] !== undefined
		? { amount: suffix[1], when: suffix[2] }
		: { amount: trimmed, when: '' };
};
