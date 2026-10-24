import * as Schema from 'effect/Schema';

export class CaregiverUsernameNotFound extends Schema.TaggedError<CaregiverUsernameNotFound>()(
	'CaregiverUsernameNotFound',
	{ message: Schema.String },
) {}

export class CaregiverUsernameAmbiguous extends Schema.TaggedError<CaregiverUsernameAmbiguous>()(
	'CaregiverUsernameAmbiguous',
	{ message: Schema.String },
) {}

export class CaregiverSelfInvitation extends Schema.TaggedError<CaregiverSelfInvitation>()(
	'CaregiverSelfInvitation',
	{ message: Schema.String },
) {}

export class CaregiverRelationshipExists extends Schema.TaggedError<CaregiverRelationshipExists>()(
	'CaregiverRelationshipExists',
	{ message: Schema.String },
) {}

export class CaregiverInvitationNotFound extends Schema.TaggedError<CaregiverInvitationNotFound>()(
	'CaregiverInvitationNotFound',
	{ message: Schema.String },
) {}

export class CaregiverInvitationNotPending extends Schema.TaggedError<CaregiverInvitationNotPending>()(
	'CaregiverInvitationNotPending',
	{ message: Schema.String },
) {}

export class CaregiverAccessLost extends Schema.TaggedError<CaregiverAccessLost>()(
	'CaregiverAccessLost',
	{ message: Schema.String },
) {}
