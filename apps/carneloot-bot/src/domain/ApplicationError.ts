import * as Schema from 'effect/Schema';
import { SqlError } from 'effect/unstable/sql/SqlError';
import { TelegramError } from 'tfx/TelegramError';

import { ReminderSchedulerError } from '../ports/ReminderScheduler.js';
import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
} from './caregivers/CaregiverError.js';
import {
	DomainPersistenceError,
	InvalidDomainInput,
	PetNameAlreadyExists,
	UserNotRegistered,
} from './DomainError.js';
import {
	DuplicateFoodEntry,
	PetAccessDenied,
	PetFoodError,
	PetFoodSetupMissing,
} from './pet-food/PetFoodError.js';

export class ConversationOperationError extends Schema.TaggedErrorClass<ConversationOperationError>()(
	'ConversationOperationError',
	{ message: Schema.String, cause: Schema.Unknown },
) {}

export const ApplicationError = Schema.Union([
	InvalidDomainInput,
	UserNotRegistered,
	PetNameAlreadyExists,
	DomainPersistenceError,
	CaregiverUsernameAmbiguous,
	CaregiverSelfInvitation,
	CaregiverRelationshipExists,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverAccessLost,
	PetAccessDenied,
	PetFoodSetupMissing,
	DuplicateFoodEntry,
	PetFoodError,
	ReminderSchedulerError,
	ConversationOperationError,
	SqlError,
	TelegramError,
]);

export type ApplicationError = typeof ApplicationError.Type;
