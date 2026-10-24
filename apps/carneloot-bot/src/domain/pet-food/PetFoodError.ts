import * as Schema from 'effect/Schema';

export class PetAccessDenied extends Schema.TaggedError<PetAccessDenied>()(
	'PetAccessDenied',
	{ message: Schema.String },
) {}

export class PetFoodSetupMissing extends Schema.TaggedError<PetFoodSetupMissing>()(
	'PetFoodSetupMissing',
	{ message: Schema.String },
) {}

export class DuplicateFoodEntry extends Schema.TaggedError<DuplicateFoodEntry>()(
	'DuplicateFoodEntry',
	{ message: Schema.String },
) {}

export class FoodEntryNotFound extends Schema.TaggedError<FoodEntryNotFound>()(
	'FoodEntryNotFound',
	{ message: Schema.String },
) {}

export class PetFoodError extends Schema.TaggedError<PetFoodError>()(
	'PetFoodError',
	{
		reason: Schema.Literals([
			'InvalidAmount',
			'InvalidTimeZone',
			'InvalidLocalTime',
			'InvalidFoodDateTime',
			'NonexistentLocalTime',
		]),
		message: Schema.String,
	},
) {}
