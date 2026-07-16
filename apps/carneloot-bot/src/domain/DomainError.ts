import * as Schema from 'effect/Schema';

export class InvalidDomainInput extends Schema.TaggedErrorClass<InvalidDomainInput>()(
	'InvalidDomainInput',
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}

export class UserNotRegistered extends Schema.TaggedErrorClass<UserNotRegistered>()(
	'UserNotRegistered',
	{ message: Schema.String },
) {}

export class PetNameAlreadyExists extends Schema.TaggedErrorClass<PetNameAlreadyExists>()(
	'PetNameAlreadyExists',
	{ message: Schema.String },
) {}

export class DomainPersistenceError extends Schema.TaggedErrorClass<DomainPersistenceError>()(
	'DomainPersistenceError',
	{
		reason: Schema.Literals(['PersistenceFailure', 'InvariantViolation']),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {
	get isRetryable(): boolean {
		return this.reason === 'PersistenceFailure';
	}
}
