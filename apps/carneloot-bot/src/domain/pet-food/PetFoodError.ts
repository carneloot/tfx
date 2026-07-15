import { Data } from 'effect';

export class PetFoodError extends Data.TaggedError('PetFoodError')<{
	readonly reason:
		| 'InvalidAmount'
		| 'InvalidTimeZone'
		| 'InvalidLocalTime'
		| 'InvalidFoodDateTime'
		| 'NonexistentLocalTime';
	readonly message: string;
}> {}
