import * as Schema from 'effect/Schema';

export class CaregiverUsernameAmbiguous extends Schema.TaggedErrorClass<CaregiverUsernameAmbiguous>()(
	'CaregiverUsernameAmbiguous',
	{ message: Schema.String },
) {}

export class CaregiverSelfInvitation extends Schema.TaggedErrorClass<CaregiverSelfInvitation>()(
	'CaregiverSelfInvitation',
	{ message: Schema.String },
) {}

export class CaregiverRelationshipExists extends Schema.TaggedErrorClass<CaregiverRelationshipExists>()(
	'CaregiverRelationshipExists',
	{ message: Schema.String },
) {}

export class CaregiverInvitationNotFound extends Schema.TaggedErrorClass<CaregiverInvitationNotFound>()(
	'CaregiverInvitationNotFound',
	{ message: Schema.String },
) {}

export class CaregiverInvitationNotPending extends Schema.TaggedErrorClass<CaregiverInvitationNotPending>()(
	'CaregiverInvitationNotPending',
	{ message: Schema.String },
) {}

export class CaregiverAccessLost extends Schema.TaggedErrorClass<CaregiverAccessLost>()(
	'CaregiverAccessLost',
	{ message: Schema.String },
) {}
