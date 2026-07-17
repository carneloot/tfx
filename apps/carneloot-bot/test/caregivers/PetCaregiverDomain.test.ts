import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { ApplicationError } from '../../src/domain/ApplicationError.js';
import {
	CaregiverAccessLost,
	CaregiverInvitationNotFound,
	CaregiverInvitationNotPending,
	CaregiverRelationshipExists,
	CaregiverSelfInvitation,
	CaregiverUsernameAmbiguous,
} from '../../src/domain/caregivers/CaregiverError.js';
import {
	CaregiverStatus,
	PetCaregiver,
	statusLabel,
} from '../../src/domain/caregivers/PetCaregiver.js';

const statuses = ['pending', 'accepted', 'rejected'] as const;

describe('caregiver domain', () => {
	it.each(statuses)('decodes %s status', (status) => {
		expect(Schema.decodeUnknownSync(CaregiverStatus)(status)).toBe(status);
	});

	it.each(['invited', 'removed', 'ACCEPTED', '', null])(
		'rejects unsupported status %j',
		(status) => {
			expect(() => Schema.decodeUnknownSync(CaregiverStatus)(status)).toThrow();
		},
	);

	it('decodes relationship timestamps as DateTime.Utc', () => {
		const createdAt = DateTime.makeUnsafe('2026-07-16T10:00:00Z');
		const updatedAt = DateTime.makeUnsafe('2026-07-16T11:00:00Z');
		const relationship = Schema.decodeUnknownSync(PetCaregiver)({
			petId: '2d72a1b4-90fc-4bf2-b51d-c59d76401e42',
			caregiverUserId: 'ee690d2d-1536-41b9-ab6d-9354282f33a3',
			status: 'accepted',
			createdAt,
			updatedAt,
		});

		expect(DateTime.isDateTime(relationship.createdAt)).toBe(true);
		expect(DateTime.isUtc(relationship.createdAt)).toBe(true);
		expect(DateTime.Equivalence(relationship.updatedAt, updatedAt)).toBe(true);
	});

	it.each([
		['pending', 'pendente'],
		['accepted', 'aceito'],
		['rejected', 'rejeitado'],
	] as const)('translates %s as %s', (status, label) => {
		expect(statusLabel(status)).toBe(label);
	});

	it.each([
		CaregiverUsernameAmbiguous,
		CaregiverSelfInvitation,
		CaregiverRelationshipExists,
		CaregiverInvitationNotFound,
		CaregiverInvitationNotPending,
		CaregiverAccessLost,
	])('includes %s in ApplicationError', (ErrorClass) => {
		const error = new ErrorClass({ message: 'expected caregiver failure' });
		expect(Schema.is(ApplicationError)(error)).toBe(true);
	});
});
