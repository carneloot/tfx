import { Data } from 'effect';
import * as Schema from 'effect/Schema';

import { SafeError } from './DeliveryOutcome.js';
import { EventId } from './NotificationEvent.js';

export interface ExternalNotificationInput {
	readonly apiKey: string;
	readonly keyword: string;
	readonly variables: Readonly<Record<string, string | number>>;
}

export class InvalidApiKey extends Data.TaggedError('InvalidApiKey')<{
	readonly message: string;
}> {}

export class TemplateNotFound extends Data.TaggedError('TemplateNotFound')<{
	readonly message: string;
}> {}

export class MissingTemplateVariables extends Data.TaggedError(
	'MissingTemplateVariables',
)<{
	readonly names: ReadonlyArray<string>;
	readonly message: string;
}> {}

export class InitialNotificationPersistenceUnavailable extends Data.TaggedError(
	'InitialNotificationPersistenceUnavailable',
)<{
	readonly message: string;
}> {}

export interface DeliveryCounts {
	readonly sent: number;
	readonly failed: number;
	readonly unknown: number;
}

export const ExternalNotificationStatus = Schema.Literals([
	'sent',
	'partial',
	'failed',
	'indeterminate',
]);
export type ExternalNotificationStatus = typeof ExternalNotificationStatus.Type;

export interface ExternalNotificationResult {
	readonly eventId: EventId;
	readonly status: ExternalNotificationStatus;
	readonly httpStatus: 200 | 202 | 207 | 502;
	readonly counts: DeliveryCounts;
	readonly failures: ReadonlyArray<SafeError>;
}

const placeholder = /\{\{\s*([^{}\s]+)\s*\}\}/gu;

export const extractTemplateVariables = (
	message: string,
): ReadonlyArray<string> =>
	Array.from(message.matchAll(placeholder), (match) => match[1]!).filter(
		(name, index, names) => names.indexOf(name) === index,
	);

export const renderNotificationTemplate = (
	message: string,
	variables: Readonly<Record<string, string | number>>,
): string | MissingTemplateVariables => {
	const missing = extractTemplateVariables(message)
		.filter((name) => variables[name] === undefined)
		.sort();
	if (missing.length > 0)
		return new MissingTemplateVariables({
			names: missing,
			message: `Missing template variables: ${missing.join(', ')}`,
		});
	return message.replace(placeholder, (_, name: string) =>
		String(variables[name]),
	);
};

export const classifyOutcome = ({ sent, failed, unknown }: DeliveryCounts) =>
	sent > 0 && failed === 0 && unknown === 0
		? { status: 'sent' as const, httpStatus: 200 as const }
		: sent > 0
			? { status: 'partial' as const, httpStatus: 207 as const }
			: unknown > 0
				? { status: 'indeterminate' as const, httpStatus: 202 as const }
				: { status: 'failed' as const, httpStatus: 502 as const };
