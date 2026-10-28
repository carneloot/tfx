import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

import { FoodAmount } from './FoodAmount.js';

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

/** Decodes feeding text without resolving its optional timestamp. */
export const FoodInput = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Struct({ amountMg: FoodAmount, when: Schema.String }),
		{
			decode: SchemaGetter.transform((input) => {
				const trimmed = input.trim();
				const suffix = foodSuffix.exec(trimmed);
				// Malformed suffixes remain in the amount and fail amount decoding.
				return suffix?.[1] !== undefined && suffix[2] !== undefined
					? { amountMg: suffix[1], when: suffix[2] }
					: { amountMg: trimmed, when: '' };
			}),
			encode: SchemaGetter.transform(({ amountMg, when }) =>
				when === '' ? amountMg : `${amountMg} ${when}`,
			),
		},
	),
);
