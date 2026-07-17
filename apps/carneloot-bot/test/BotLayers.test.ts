import { Layer } from 'effect';
import { BotBuilder, Middleware } from 'tfx';
import { describe, expect, it } from 'vitest';

import * as AccountHandlers from '../src/bot/AccountHandlers.js';
import { built } from '../src/bot/AddPetConversation.js';
import * as CaregiverHandlers from '../src/bot/CaregiverHandlers.js';
import { Carneloot } from '../src/bot/Declaration.js';
import * as PetFoodHandlers from '../src/bot/PetFoodHandlers.js';
import * as PetHandlers from '../src/bot/PetHandlers.js';
import * as RegisteredUser from '../src/bot/RegisteredUser.js';

describe('public bot Layer construction', () => {
	it('composes declarations, middleware, handlers, and conversation without private imports', () => {
		const account = BotBuilder.group(Carneloot, 'account', (handlers) =>
			handlers.handle('register', () => AccountHandlers.registerCurrent),
		);
		const pets = BotBuilder.group(Carneloot, 'pets', (handlers) =>
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
		const petFood = BotBuilder.group(Carneloot, 'petFood', (handlers) =>
			handlers
				.handle(
					'configureDayStart',
					() => PetFoodHandlers.startConfigureDayStart,
				)
				.handle(
					'configureReminderDelay',
					() => PetFoodHandlers.startConfigureReminderDelay,
				)
				.handle('foodStatus', () => PetFoodHandlers.foodStatus)
				.handle('addFood', () => PetFoodHandlers.startAddFood),
		);
		const middleware = Middleware.layer(RegisteredUser.live);
		const integrated = Layer.provide(
			Layer.mergeAll(account, pets, petFood),
			middleware,
		);
		expect(integrated).toBeDefined();
		expect(built.declaration.id).toBe('add-owned-pet');
		expect(Object.keys(Carneloot.groups)).toEqual([
			'account',
			'pets',
			'petFood',
		]);
	});
});
