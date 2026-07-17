import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';

import * as PetInvitations from '../../src/bot/conversations/PetInvitationsConversation.js';
import * as StopCaring from '../../src/bot/conversations/StopCaringConversation.js';

describe('invitee caregiver conversation declarations', () => {
	it.each([
		[
			PetInvitations.declaration,
			'pet-caregiver-invitations',
			'invitation',
			['invitation', 'confirm'],
		],
		[StopCaring.declaration, 'stop-caring-for-pet', 'pet', ['pet', 'confirm']],
	] as const)(
		'declares durable %s version 1',
		(declaration, id, initialStep, steps) => {
			expect(declaration.id).toBe(id);
			expect(declaration.version).toBe(1);
			expect(declaration.initialStep).toBe(initialStep);
			expect(Object.keys(declaration.steps)).toEqual(steps);
			expect(Duration.toMillis(declaration.idleTimeout ?? 0)).toBe(
				15 * 60 * 1000,
			);
		},
	);

	it('rejects empty invitation startup options', () => {
		expect(() =>
			PetInvitations.declaration.startup.make({
				actorId: '00000000-0000-4000-8000-000000000001',
				botId: 'bot',
				telegramUserId: 1,
				invitations: [],
			}),
		).toThrow();
	});

	it('rejects empty cared-pet startup options', () => {
		expect(() =>
			StopCaring.declaration.startup.make({
				actorId: '00000000-0000-4000-8000-000000000001',
				botId: 'bot',
				telegramUserId: 1,
				pets: [],
			}),
		).toThrow();
	});

	it('implements every declared step for durable resume', () => {
		for (const conversation of [PetInvitations.built, StopCaring.built]) {
			expect(Object.keys(conversation.implementations)).toEqual(
				Object.keys(conversation.declaration.steps),
			);
		}
	});
});
