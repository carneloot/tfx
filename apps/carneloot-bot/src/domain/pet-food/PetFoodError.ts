import { Data } from 'effect';

export class PetAccessDenied extends Data.TaggedError('PetAccessDenied')<{
	readonly message: string;
}> {}
export class PetFoodSetupMissing extends Data.TaggedError(
	'PetFoodSetupMissing',
)<{ readonly message: string }> {}
export class DuplicateFoodEntry extends Data.TaggedError('DuplicateFoodEntry')<{
	readonly message: string;
}> {}

export class PetFoodError extends Data.TaggedError('PetFoodError')<{
	readonly reason:
		| 'InvalidAmount'
		| 'InvalidTimeZone'
		| 'InvalidLocalTime'
		| 'InvalidFoodDateTime'
		| 'NonexistentLocalTime';
	readonly message: string;
}> {}
