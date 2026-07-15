import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import * as SchemaIssue from 'effect/SchemaIssue';

const maximum = 100_000_000n;
const invalid = (value: string) =>
	new SchemaIssue.InvalidValue(Option.some(value), {
		message: 'Expected a positive food amount of at most 100kg',
	});
const parse = (input: string): bigint | undefined => {
	const match = /^([0-9]+)(?:\.([0-9]+))?\s*(mg|g|kg)?$/iu.exec(input.trim());
	if (match === null) return undefined;
	const unit = (match[3]?.toLowerCase() ?? 'g') as 'mg' | 'g' | 'kg';
	const scale = unit === 'mg' ? 1n : unit === 'g' ? 1_000n : 1_000_000n;
	const fraction = match[2] ?? '';
	const denominator = 10n ** BigInt(fraction.length);
	const numerator = BigInt(match[1]!) * denominator + BigInt(fraction || '0');
	const scaled = numerator * scale;
	if (scaled % denominator !== 0n) return undefined;
	const milligrams = scaled / denominator;
	return milligrams >= 1n && milligrams <= maximum ? milligrams : undefined;
};
export const FoodAmountMg = Schema.Number.check(
	Schema.makeFilter(
		(value) =>
			Number.isSafeInteger(value) && value >= 1 && value <= Number(maximum),
		{ message: 'Invalid food milligrams' },
	),
).pipe(Schema.brand('FoodAmountMg'));
export type FoodAmount = typeof FoodAmountMg.Type;
export const FoodAmount = Schema.String.pipe(
	Schema.decodeTo(FoodAmountMg, {
		decode: SchemaGetter.transformOrFail((input) => {
			const value = parse(input);
			return value === undefined
				? Effect.fail(invalid(input))
				: Effect.succeed(Number(value) as FoodAmount);
		}),
		encode: SchemaGetter.transform((value) => `${value}mg`),
	}),
);
