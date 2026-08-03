import * as Schema from 'effect/Schema';

export class NotificationReplyRejected extends Schema.TaggedErrorClass<NotificationReplyRejected>()(
	'NotificationReplyRejected',
	{
		reason: Schema.Literals(['OwnerSelfReply']),
		message: Schema.String,
	},
) {}
