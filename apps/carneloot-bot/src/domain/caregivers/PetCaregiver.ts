import * as Schema from 'effect/Schema';

import { PetId, UserId } from '../Ids.js';

export const CaregiverStatus = Schema.Literals([
	'pending',
	'accepted',
	'rejected',
]);
export type CaregiverStatus = typeof CaregiverStatus.Type;

export const PetCaregiver = Schema.Struct({
	petId: PetId,
	caregiverUserId: UserId,
	status: CaregiverStatus,
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
});
export type PetCaregiver = typeof PetCaregiver.Type;

export const statusLabel = (status: CaregiverStatus): string =>
	status === 'pending'
		? 'pendente'
		: status === 'accepted'
			? 'aceito'
			: 'rejeitado';
