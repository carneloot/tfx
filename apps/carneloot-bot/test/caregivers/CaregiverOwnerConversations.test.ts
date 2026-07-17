import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';

import * as DeletePet from '../../src/bot/conversations/DeletePetConversation.js';
import * as InviteCaregiver from '../../src/bot/conversations/InviteCaregiverConversation.js';
import * as ListCaregivers from '../../src/bot/conversations/ListCaregiversConversation.js';
import * as RemoveCaregiver from '../../src/bot/conversations/RemoveCaregiverConversation.js';

describe('owner caregiver conversation declarations', () => {
	it.each([
		[DeletePet.declaration, 'delete-pet', ['pet', 'confirm']],
		[InviteCaregiver.declaration, 'invite-pet-caregiver', ['pet', 'username']],
		[RemoveCaregiver.declaration, 'remove-pet-caregiver', ['pet', 'caregiver']],
		[ListCaregivers.declaration, 'list-pet-caregivers', ['pet']],
	] as const)('declares durable %s version 1', (declaration, id, steps) => {
		expect(declaration.id).toBe(id);
		expect(declaration.version).toBe(1);
		expect(declaration.initialStep).toBe('pet');
		expect(Object.keys(declaration.steps)).toEqual(steps);
		expect(Duration.toMillis(declaration.idleTimeout ?? 0)).toBe(
			15 * 60 * 1000,
		);
	});

	it('rejects empty owned-pet startup arrays', () => {
		const input = {
			actorId: '00000000-0000-4000-8000-000000000001',
			botId: 'bot',
			telegramUserId: 1,
			pets: [],
		};
		expect(() => DeletePet.declaration.startup.make(input)).toThrow();
		expect(() => InviteCaregiver.declaration.startup.make(input)).toThrow();
		expect(() => RemoveCaregiver.declaration.startup.make(input)).toThrow();
		expect(() => ListCaregivers.declaration.startup.make(input)).toThrow();
	});

	it('keeps every declared step implemented for durable resume', () => {
		for (const conversation of [
			DeletePet.built,
			InviteCaregiver.built,
			RemoveCaregiver.built,
			ListCaregivers.built,
		]) {
			expect(Object.keys(conversation.implementations)).toEqual(
				Object.keys(conversation.declaration.steps),
			);
		}
	});
});
