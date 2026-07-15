import { Data } from 'effect';
export class InvalidDomainInput extends Data.TaggedError('InvalidDomainInput')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
export class UserNotRegistered extends Data.TaggedError('UserNotRegistered')<{
	readonly message: string;
}> {}
export class PetNameAlreadyExists extends Data.TaggedError(
	'PetNameAlreadyExists',
)<{
	readonly message: string;
}> {}
export class DomainPersistenceError extends Data.TaggedError(
	'DomainPersistenceError',
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
