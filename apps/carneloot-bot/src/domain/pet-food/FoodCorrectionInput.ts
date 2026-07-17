import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../DomainError.js';
import {
	FoodAmount,
	type FoodAmount as FoodAmountValue,
} from './FoodAmount.js';
import { FoodWhenInput } from './FoodWhenInput.js';

export interface FoodCorrection {
	readonly amountMg?: FoodAmountValue;
	readonly when?: string;
}

const invalid = (input: string, cause?: unknown) =>
	new InvalidDomainInput({
		message: 'Expected a food amount, a timestamp, or both',
		cause,
	});

const decodeWhen = Schema.decodeUnknownEffect(FoodWhenInput);
const decodeAmount = Schema.decodeUnknownEffect(FoodAmount);

/** Parses correction text without interpreting its local timestamp. */
export const parse = (
	input: string,
): Effect.Effect<FoodCorrection, InvalidDomainInput> => {
	const trimmed = input.trim();
	if (trimmed.length === 0) return Effect.fail(invalid(input));

	return Effect.matchEffect(decodeWhen(trimmed), {
		onSuccess: (when) => Effect.succeed({ when }),
		onFailure: () => {
			const match = /^(\S+)(?:\s+(.*))?$/u.exec(trimmed);
			const amountInput = match?.[1];
			if (amountInput === undefined) return Effect.fail(invalid(input));
			return Effect.flatMap(
				Effect.mapError(decodeAmount(amountInput), (cause) =>
					invalid(input, cause),
				),
				(amountMg) => {
					const remainder = match?.[2]?.trim();
					if (remainder === undefined || remainder.length === 0)
						return Effect.succeed({ amountMg });
					return Effect.map(
						Effect.mapError(decodeWhen(remainder), (cause) =>
							invalid(input, cause),
						),
						(when) => ({ amountMg, when }),
					);
				},
			);
		},
	});
};
