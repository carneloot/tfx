import * as Schema from 'effect/Schema';

export class InvalidDomainInput extends Schema.TaggedError<InvalidDomainInput>()(
	'InvalidDomainInput',
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}

export class UserNotRegistered extends Schema.TaggedError<UserNotRegistered>()(
	'UserNotRegistered',
	{ message: Schema.String },
) {}

export class PetNameAlreadyExists extends Schema.TaggedError<PetNameAlreadyExists>()(
	'PetNameAlreadyExists',
	{ message: Schema.String },
) {}

export class DomainPersistenceError extends Schema.TaggedError<DomainPersistenceError>()(
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
