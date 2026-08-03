import * as Schema from 'effect/Schema';

import { UserId } from '../Ids.js';
import { Uuid } from '../Uuid.js';

export const NotificationTemplateId = Uuid.pipe(
	Schema.brand('NotificationTemplateId'),
);
export type NotificationTemplateId = typeof NotificationTemplateId.Type;
export const NotificationKeyword = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand('NotificationKeyword'));
export type NotificationKeyword = typeof NotificationKeyword.Type;
export const NotificationTemplateMessage = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4096),
).pipe(Schema.brand('NotificationTemplateMessage'));
export type NotificationTemplateMessage =
	typeof NotificationTemplateMessage.Type;
export const NotificationTemplate = Schema.Struct({
	id: NotificationTemplateId,
	ownerUserId: UserId,
	keyword: NotificationKeyword,
	message: NotificationTemplateMessage,
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
});
export type NotificationTemplate = typeof NotificationTemplate.Type;
