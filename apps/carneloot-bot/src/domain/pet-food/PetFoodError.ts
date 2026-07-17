import * as Schema from 'effect/Schema';

export class PetAccessDenied extends Schema.TaggedErrorClass<PetAccessDenied>()(
	'PetAccessDenied',
	{ message: Schema.String },
) {}

export class PetFoodSetupMissing extends Schema.TaggedErrorClass<PetFoodSetupMissing>()(
	'PetFoodSetupMissing',
	{ message: Schema.String },
) {}

export class DuplicateFoodEntry extends Schema.TaggedErrorClass<DuplicateFoodEntry>()(
	'DuplicateFoodEntry',
	{ message: Schema.String },
) {}

export class FoodEntryNotFound extends Schema.TaggedErrorClass<FoodEntryNotFound>()(
	'FoodEntryNotFound',
	{ message: Schema.String },
) {}

export class PetFoodError extends Schema.TaggedErrorClass<PetFoodError>()(
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
