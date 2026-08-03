import * as Schema from 'effect/Schema';
import { SqlError } from 'effect/unstable/sql/SqlError';
import { TelegramError } from 'tfx/TelegramError';

import { FoodReplyLedgerError } from '../application/RouteFoodReply.js';
import { FoodNotificationSchedulerError } from '../ports/FoodNotificationScheduler.js';
import { ReminderSchedulerError } from '../ports/ReminderScheduler.js';
import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
	CaregiverUsernameNotFound,
} from './caregivers/CaregiverError.js';
import {
	DomainPersistenceError,
	InvalidDomainInput,
	PetNameAlreadyExists,
	UserNotRegistered,
} from './DomainError.js';
import {
	InitialNotificationPersistenceUnavailable,
	InvalidApiKey,
	MissingTemplateVariables,
	TemplateNotFound,
} from './notifications/ExternalNotification.js';
import {
	DuplicateFoodEntry,
	FoodEntryNotFound,
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
	CaregiverUsernameNotFound,
	CaregiverSelfInvitation,
	CaregiverRelationshipExists,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverAccessLost,
	PetAccessDenied,
	PetFoodSetupMissing,
	DuplicateFoodEntry,
	FoodEntryNotFound,
	PetFoodError,
	ReminderSchedulerError,
	FoodNotificationSchedulerError,
	FoodReplyLedgerError,
	ConversationOperationError,
	InvalidApiKey,
	TemplateNotFound,
	MissingTemplateVariables,
	InitialNotificationPersistenceUnavailable,
	SqlError,
	TelegramError,
]);

export type ApplicationError = typeof ApplicationError.Type;
