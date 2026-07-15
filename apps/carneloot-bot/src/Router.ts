import { BotBuilder, BotRouter, DispatchOutcome } from 'tfx';

import * as AccountHandlers from './bot/AccountHandlers.js';
import * as AddPetConversation from './bot/AddPetConversation.js';
import * as CancelConversation from './bot/CancelConversation.js';
import * as AddFoodConversation from './bot/conversations/AddFoodConversation.js';
import * as ConfigureDayStartConversation from './bot/conversations/ConfigureDayStartConversation.js';
import * as ConfigureReminderDelayConversation from './bot/conversations/ConfigureReminderDelayConversation.js';
import { Carneloot } from './bot/Declaration.js';
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
			.handle('listPets', () => PetHandlers.listPets),
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
			.handle('addFood', () => PetFoodHandlers.startAddFood),
);
export const conversations = Object.freeze([
	AddPetConversation.built,
	ConfigureDayStartConversation.built,
	ConfigureReminderDelayConversation.built,
	AddFoodConversation.built,
]);
export const make = (botUsername: string) =>
	BotRouter.make({
		bot: Carneloot,
		groups: [accountHandlers, petHandlers, petFoodHandlers],
		conversations,
		botUsername,
		cancel: () => CancelConversation.cancelCurrent,
		mapError: (error) => {
			if (
				error._tag === 'UserNotRegistered' ||
				error._tag === 'InvalidDomainInput'
			)
				return DispatchOutcome.permanentInvalid(error._tag);
			return DispatchOutcome.retryableFailure('application-handler-failed');
		},
	});
