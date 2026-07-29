import { Layer } from 'effect';
import { BotBuilder, Middleware } from 'tfx';
import { describe, expect, it } from 'vitest';

import * as AccountHandlers from '../src/bot/AccountHandlers.js';
import { built } from '../src/bot/AddPetConversation.js';
import * as CaregiverHandlers from '../src/bot/CaregiverHandlers.js';
import { Carneloot } from '../src/bot/Declaration.js';
import * as FoodReplyHandler from '../src/bot/FoodReplyHandler.js';
import * as PetFoodHandlers from '../src/bot/PetFoodHandlers.js';
import * as PetHandlers from '../src/bot/PetHandlers.js';
import * as RegisteredUser from '../src/bot/RegisteredUser.js';
import * as Router from '../src/Router.js';

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
				.handle('addFood', () => PetFoodHandlers.startAddFood)
				.handle('correctFood', () => PetFoodHandlers.startCorrectFood)
				.handle('deleteFood', () => PetFoodHandlers.startDeleteFood)
				.handle('addFoodToAll', PetFoodHandlers.addFoodToAll),
		);
		const replies = BotBuilder.group(Carneloot, 'replies', (handlers) =>
			handlers.handleMessage('foodReply', FoodReplyHandler.handle),
		);
		const middleware = Middleware.layer(RegisteredUser.live);
		const integrated = Layer.provide(
			Layer.mergeAll(account, pets, petFood, replies),
			middleware,
		);
		expect(integrated).toBeDefined();
		expect(built.declaration.id).toBe('add-owned-pet');
		expect(Object.keys(Carneloot.groups)).toEqual([
			'account',
			'pets',
			'petFood',
			'replies',
		]);
		expect(
			[
				Router.accountHandlers,
				Router.petHandlers,
				Router.petFoodHandlers,
				Router.replyHandlers,
			].map((group) => ({
				groupId: group.groupId,
				entries: group.entries.map((entry) =>
					entry._tag === 'Command'
						? `${entry._tag}:${entry.commandId}`
						: `${entry._tag}:${entry.messageHandlerId}`,
				),
			})),
		).toEqual([
			{ groupId: 'account', entries: ['Command:register'] },
			{
				groupId: 'pets',
				entries: [
					'Command:addPet',
					'Command:listPets',
					'Command:deletePet',
					'Command:inviteCaregiver',
					'Command:removeCaregiver',
					'Command:listCaregivers',
					'Command:petInvitations',
					'Command:stopCaring',
				],
			},
			{
				groupId: 'petFood',
				entries: [
					'Command:configureDayStart',
					'Command:configureReminderDelay',
					'Command:foodStatus',
					'Command:addFood',
					'Command:correctFood',
					'Command:deleteFood',
					'Command:addFoodToAll',
				],
			},
			{ groupId: 'replies', entries: ['Message:foodReply'] },
		]);
	});
});
