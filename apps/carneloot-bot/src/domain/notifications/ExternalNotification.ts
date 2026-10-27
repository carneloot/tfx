import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { DeliveryId } from './NotificationDelivery.js';
import { EventId } from './NotificationEvent.js';

export const ExternalNotificationInput = Schema.Struct({
	apiKey: Schema.NonEmptyString,
	keyword: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	variables: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite])),
	),
});
export interface ExternalNotificationInput extends Schema.Schema.Type<
	typeof ExternalNotificationInput
> {}

export class InvalidApiKey extends Schema.TaggedError<InvalidApiKey>()(
	'InvalidApiKey',
	{},
) {}
export class TemplateNotFound extends Schema.TaggedError<TemplateNotFound>()(
	'TemplateNotFound',
	{},
) {}
export class MissingTemplateVariables extends Schema.TaggedError<MissingTemplateVariables>()(
	'MissingTemplateVariables',
	{
		variables: Schema.Array(Schema.String),
	},
) {}
export class InvalidRenderedNotification extends Schema.TaggedError<InvalidRenderedNotification>()(
	'InvalidRenderedNotification',
	{},
) {}
export class InitialNotificationPersistenceUnavailable extends Schema.TaggedError<InitialNotificationPersistenceUnavailable>()(
	'InitialNotificationPersistenceUnavailable',
	{},
) {}

export const DeliveryCounts = Schema.Struct({
	sent: Schema.Number,
	failed: Schema.Number,
	unknown: Schema.Number,
});
export interface DeliveryCounts extends Schema.Schema.Type<
	typeof DeliveryCounts
> {}
export const ExternalNotificationResult = Schema.Struct({
	eventId: EventId,
	status: Schema.Literals(['sent', 'partial', 'failed', 'indeterminate']),
	counts: DeliveryCounts,
	failures: Schema.Array(
		Schema.Struct({ deliveryId: DeliveryId, code: Schema.String }),
	),
});
export interface ExternalNotificationResult extends Schema.Schema.Type<
	typeof ExternalNotificationResult
> {}

export const classifyOutcome = ({ sent, failed, unknown }: DeliveryCounts) =>
	sent > 0 && failed === 0 && unknown === 0
		? { status: 'sent' as const, httpStatus: 200 as const }
		: sent > 0
			? { status: 'partial' as const, httpStatus: 207 as const }
			: unknown > 0
				? { status: 'indeterminate' as const, httpStatus: 202 as const }
				: { status: 'failed' as const, httpStatus: 502 as const };

export const render = Effect.fn('ExternalNotification.render')(function* (
	message: string,
	variables: ExternalNotificationInput['variables'] = {},
) {
	const names = [
		...new Set(
			[...message.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1] ?? ''),
		),
	];
	const missing = names
		.filter((name) => !Object.hasOwn(variables, name))
		.sort();
	if (missing.length > 0)
		return yield* new MissingTemplateVariables({ variables: missing });
	// A callback avoids replacement-string expansion and recursive substitution.
	const text = message.replace(/\{\{(\w+)\}\}/gu, (_, name: string) =>
		String(variables[name]),
	);
	if (text.length === 0 || text.length > 4096)
		return yield* new InvalidRenderedNotification();
	return text;
});
