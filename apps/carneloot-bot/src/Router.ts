import { BotBuilder, BotRouter, DispatchOutcome } from 'tfx';
import { isRetryableError, type TaggedError } from 'tfx/TaggedError';

import * as AccountHandlers from './bot/AccountHandlers.js';
import * as AddPetConversation from './bot/AddPetConversation.js';
import * as CancelConversation from './bot/CancelConversation.js';
import * as CaregiverHandlers from './bot/CaregiverHandlers.js';
import * as AddFoodConversation from './bot/conversations/AddFoodConversation.js';
import * as ConfigureDayStartConversation from './bot/conversations/ConfigureDayStartConversation.js';
import * as ConfigureReminderDelayConversation from './bot/conversations/ConfigureReminderDelayConversation.js';
import * as CorrectFoodConversation from './bot/conversations/CorrectFoodConversation.js';
import * as DeleteFoodConversation from './bot/conversations/DeleteFoodConversation.js';
import * as DeletePetConversation from './bot/conversations/DeletePetConversation.js';
import * as InviteCaregiverConversation from './bot/conversations/InviteCaregiverConversation.js';
import * as ListCaregiversConversation from './bot/conversations/ListCaregiversConversation.js';
import * as PetInvitationsConversation from './bot/conversations/PetInvitationsConversation.js';
import * as RemoveCaregiverConversation from './bot/conversations/RemoveCaregiverConversation.js';
import * as StopCaringConversation from './bot/conversations/StopCaringConversation.js';
import { Carneloot } from './bot/Declaration.js';
import * as FoodReplyHandler from './bot/FoodReplyHandler.js';
import * as PetFoodHandlers from './bot/PetFoodHandlers.js';
import * as PetHandlers from './bot/PetHandlers.js';

export const accountHandlers = BotBuilder.buildGroup(
	Carneloot,
	'account',
	(handlers) =>
		handlers.handle('register', () => AccountHandlers.registerCurrent),
);
export const petHandlers = BotBuilder.buildGroup(
	Carneloot,
	'pets',
	(handlers) =>
		handlers
			.handle('addPet', () => PetHandlers.startAddPet)
			.handle('listPets', () => PetHandlers.listPets)
			.handle('deletePet', () => CaregiverHandlers.startDeletePet)
			.handle('inviteCaregiver', () => CaregiverHandlers.startInviteCaregiver)
			.handle('removeCaregiver', () => CaregiverHandlers.startRemoveCaregiver)
			.handle('listCaregivers', () => CaregiverHandlers.startListCaregivers)
			.handle('petInvitations', () => CaregiverHandlers.startPetInvitations)
			.handle('stopCaring', () => CaregiverHandlers.startStopCaring),
);
export const petFoodHandlers = BotBuilder.buildGroup(
	Carneloot,
	'petFood',
	(handlers) =>
		handlers
			.handle('configureDayStart', () => PetFoodHandlers.startConfigureDayStart)
			.handle(
				'configureReminderDelay',
				() => PetFoodHandlers.startConfigureReminderDelay,
			)
			.handle('foodStatus', () => PetFoodHandlers.foodStatus)
			.handle('addFood', () => PetFoodHandlers.startAddFood)
			.handle('correctFood', () => PetFoodHandlers.startCorrectFood)
			.handle('deleteFood', () => PetFoodHandlers.startDeleteFood)
			.handle('addFoodToAll', PetFoodHandlers.addFoodToAll),
);
export const replyHandlers = BotBuilder.buildGroup(
	Carneloot,
	'replies',
	(handlers) => handlers.handleMessage('foodReply', FoodReplyHandler.handle),
);
export const conversations = Object.freeze([
	AddPetConversation.built,
	ConfigureDayStartConversation.built,
	ConfigureReminderDelayConversation.built,
	AddFoodConversation.built,
	CorrectFoodConversation.built,
	DeleteFoodConversation.built,
	DeletePetConversation.built,
	InviteCaregiverConversation.built,
	RemoveCaregiverConversation.built,
	ListCaregiversConversation.built,
	PetInvitationsConversation.built,
	StopCaringConversation.built,
]);
const isTaggedError = (value: unknown): value is TaggedError =>
	typeof value === 'object' &&
	value !== null &&
	'_tag' in value &&
	typeof value._tag === 'string';
const taggedCause = (error: TaggedError): TaggedError | undefined =>
	'cause' in error && isTaggedError(error.cause) ? error.cause : undefined;
export const classifyError = (
	error: TaggedError,
): DispatchOutcome.DispatchOutcome => {
	const framework = BotRouter.classifyFrameworkError(error);
	if (framework !== undefined) return framework;
	if (error._tag === 'ConversationOperationError') {
		const cause = taggedCause(error);
		return cause === undefined
			? DispatchOutcome.fatal('conversation-operation-invalid-cause')
			: classifyError(cause);
	}
	switch (error._tag) {
		case 'InvalidDomainInput':
		case 'UserNotRegistered':
		case 'PetNameAlreadyExists':
		case 'PetAccessDenied':
		case 'PetFoodSetupMissing':
		case 'DuplicateFoodEntry':
		case 'FoodEntryNotFound':
		case 'PetFoodError':
		case 'MissingConversationScope':
		case 'CaregiverUsernameAmbiguous':
		case 'CaregiverUsernameNotFound':
		case 'CaregiverSelfInvitation':
		case 'CaregiverRelationshipExists':
		case 'CaregiverInvitationNotFound':
		case 'CaregiverInvitationNotPending':
		case 'CaregiverAccessLost':
			return DispatchOutcome.permanentInvalid('invalid-application-update');
		case 'DomainPersistenceError':
			return isRetryableError(error)
				? DispatchOutcome.retryableFailure(
						'application-persistence-unavailable',
					)
				: DispatchOutcome.fatal('application-persistence-invariant');
		case 'ReminderSchedulerError':
			return isRetryableError(error)
				? DispatchOutcome.retryableFailure('reminder-scheduler-unavailable')
				: DispatchOutcome.fatal('reminder-scheduler-invariant');
		case 'FoodReplyLedgerError':
			return DispatchOutcome.fatal('food-reply-ledger-invalid');
		case 'FoodNotificationSchedulerError':
			return isRetryableError(error)
				? DispatchOutcome.retryableFailure(
						'food-notification-scheduler-unavailable',
					)
				: DispatchOutcome.fatal('food-notification-scheduler-invariant');
		case 'TelegramError':
			// All Telegram operations exposed by Carneloot handlers are outputs.
			return DispatchOutcome.handledWithOutputFailure('telegram-output-failed');
		default:
			return isRetryableError(error)
				? DispatchOutcome.retryableFailure('retryable-application-error')
				: DispatchOutcome.fatal('unclassified-application-error');
	}
};
export const make = (botUsername: string) =>
	BotRouter.make({
		bot: Carneloot,
		groups: [accountHandlers, petHandlers, petFoodHandlers, replyHandlers],
		conversations,
		botUsername,
		cancel: () => CancelConversation.cancelCurrent,
		mapError: classifyError,
	});
